#!/usr/bin/env python3
"""
MUD Behavior Heatmap Generator

Generates synthetic MUD player session data on a 10x10 room grid and visualizes
behavioral overlays as composited heatmaps. Runs on two grid variants (open vs
constrained) to test whether archetype behavioral signatures survive topology changes.
"""

import os
import random
from datetime import datetime, timedelta
from collections import defaultdict

import numpy as np
import networkx as nx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.colors as mcolors
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
import seaborn as sns

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
SEED = 42
OUTPUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "output_heatmaps")
GRID_ROWS, GRID_COLS = 10, 10
SESSIONS_PER_ARCHETYPE = 10
ARCHETYPES = ["explorer", "social", "investigator", "grinder", "lurker"]
COMMAND_TYPES = ["look", "examine", "talk", "take", "inventory", "move", "wait", "say"]
SESSION_MIN_MINUTES, SESSION_MAX_MINUTES = 15, 120

# Nexus points — same positions for both variants
NEXUS_POINTS = [(2, 7), (7, 3), (5, 8)]  # (row, col)

# Room type definitions with spatial clustering
ROOM_TYPE_COLORS = {
    "tavern": "#D4A017",
    "market": "#FF6347",
    "church": "#8A2BE2",
    "alley": "#696969",
    "plaza": "#FFD700",
    "residence": "#8FBC8F",
    "workshop": "#CD853F",
    "bridge": "#4682B4",
    "cemetery": "#2F4F4F",
    "garden": "#32CD32",
}

ARCHETYPE_COLORS = {
    "explorer": "#1f77b4",
    "social": "#ff7f0e",
    "investigator": "#2ca02c",
    "grinder": "#d62728",
    "lurker": "#9467bd",
}


def assign_room_types():
    """Assign room types to the 10x10 grid with spatial clustering."""
    grid = [[None] * GRID_COLS for _ in range(GRID_ROWS)]

    # Seed cluster centers for each type
    clusters = {
        "tavern": [(1, 1), (6, 8)],
        "market": [(0, 4), (4, 6)],
        "church": [(8, 8)],
        "alley": [(3, 2), (7, 5), (5, 0)],
        "plaza": [(5, 5), (2, 3)],
        "residence": [(0, 0), (9, 9), (8, 1)],
        "workshop": [(3, 7), (7, 1)],
        "bridge": [(r, c) for r in range(GRID_ROWS) for c in [4, 5]
                   if grid[r][c] is None][:4],
        "cemetery": [(9, 6)],
        "garden": [(1, 8), (6, 2)],
    }

    # Place cluster centers
    for rtype, centers in clusters.items():
        for r, c in centers:
            if 0 <= r < GRID_ROWS and 0 <= c < GRID_COLS and grid[r][c] is None:
                grid[r][c] = rtype

    # Fill remaining rooms by nearest cluster center
    rng = random.Random(SEED + 1)
    type_list = list(ROOM_TYPE_COLORS.keys())
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if grid[r][c] is not None:
                continue
            # Find nearest assigned room and adopt its type with some noise
            best_dist = float("inf")
            best_type = None
            for rtype, centers in clusters.items():
                for cr, cc in centers:
                    d = abs(r - cr) + abs(c - cc)
                    if d < best_dist:
                        best_dist = d
                        best_type = rtype
            # 30% chance of random type for diversity
            if rng.random() < 0.3:
                grid[r][c] = rng.choice(type_list)
            else:
                grid[r][c] = best_type

    # Force bridge rooms at river crossings
    for r in range(GRID_ROWS):
        for c in [4, 5]:
            if grid[r][c] != "bridge":
                # Only force some as bridges for variant B
                pass

    return grid


def room_id(r, c):
    return r * GRID_COLS + c


def room_coords(rid):
    return rid // GRID_COLS, rid % GRID_COLS


# ---------------------------------------------------------------------------
# Grid Variant A — Open
# ---------------------------------------------------------------------------
def build_open_grid():
    """All 100 rooms, cardinal connections, plus 5-8 shortcut edges."""
    G = nx.DiGraph()
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            G.add_node(room_id(r, c), pos=(c, GRID_ROWS - 1 - r))

    # Cardinal connections (bidirectional)
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            rid = room_id(r, c)
            if r > 0:
                G.add_edge(rid, room_id(r - 1, c))
                G.add_edge(room_id(r - 1, c), rid)
            if c < GRID_COLS - 1:
                G.add_edge(rid, room_id(r, c + 1))
                G.add_edge(room_id(r, c + 1), rid)

    # Shortcut connections (bidirectional, non-adjacent)
    rng = random.Random(SEED + 10)
    shortcuts_added = 0
    attempts = 0
    shortcuts = []
    while shortcuts_added < 7 and attempts < 200:
        r1, c1 = rng.randint(0, 9), rng.randint(0, 9)
        r2, c2 = rng.randint(0, 9), rng.randint(0, 9)
        dist = abs(r1 - r2) + abs(c1 - c2)
        if dist >= 3:
            a, b = room_id(r1, c1), room_id(r2, c2)
            if not G.has_edge(a, b):
                G.add_edge(a, b)
                G.add_edge(b, a)
                shortcuts.append((a, b))
                shortcuts_added += 1
        attempts += 1

    return G, shortcuts


# ---------------------------------------------------------------------------
# Grid Variant B — Constrained
# ---------------------------------------------------------------------------
def build_constrained_grid():
    """Same grid with river, walled quarter, hilltop, one-way alleys."""
    G = nx.DiGraph()

    # River columns: 4-5, impassable except at bridge rows
    river_cols = {4, 5}
    bridge_rows = {2, 5, 8}  # 3 bridge crossings

    # Walled quarter: top-right corner 0-2 rows, 7-9 cols
    walled_quarter = {(r, c) for r in range(3) for c in range(7, 10)}
    walled_gates = {(2, 7), (0, 7)}  # gate rooms — entry points

    # Hilltop zone: rows 0-1, cols 0-2 (accessible only from south edge row 2)
    hilltop_zone = {(r, c) for r in range(2) for c in range(3)}
    hilltop_south_entry = {(1, c) for c in range(3)}  # south edge of hilltop

    # Impassable river rooms (not bridges)
    impassable = set()
    for r in range(GRID_ROWS):
        for c in river_cols:
            if r not in bridge_rows:
                impassable.add((r, c))

    # Add all passable nodes
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if (r, c) not in impassable:
                G.add_node(room_id(r, c), pos=(c, GRID_ROWS - 1 - r))

    # Cardinal connections with constraints
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if (r, c) in impassable:
                continue
            rid = room_id(r, c)

            for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1)]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < GRID_ROWS and 0 <= nc < GRID_COLS:
                    if (nr, nc) in impassable:
                        continue
                    nid = room_id(nr, nc)

                    # Walled quarter: only enter through gates
                    if (nr, nc) in walled_quarter and (r, c) not in walled_quarter:
                        if (nr, nc) not in walled_gates:
                            continue
                    if (r, c) in walled_quarter and (nr, nc) not in walled_quarter:
                        if (r, c) not in walled_gates:
                            continue

                    # Hilltop: only enter from south (row 2 going north)
                    if (nr, nc) in hilltop_zone and (r, c) not in hilltop_zone:
                        if dr != -1:  # must be moving north (dr=-1)
                            continue
                        if (nr, nc) not in hilltop_south_entry:
                            continue
                    if (r, c) in hilltop_zone and (nr, nc) not in hilltop_zone:
                        # Can exit hilltop only southward
                        if dr != 1:
                            continue

                    G.add_edge(rid, nid)

    # One-way alleys: some plaza→alley connections are one-way
    rng = random.Random(SEED + 20)
    room_types = assign_room_types()
    oneway_alleys = []
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if room_types[r][c] == "alley" and (r, c) not in impassable:
                rid = room_id(r, c)
                neighbors = list(G.predecessors(rid))
                for nid in neighbors:
                    nr, nc = room_coords(nid)
                    if room_types[nr][nc] == "plaza" and rng.random() < 0.5:
                        # Make plaza→alley one-way: remove alley→plaza
                        if G.has_edge(rid, nid) and G.in_degree(rid) >= 3:
                            G.remove_edge(rid, nid)
                            oneway_alleys.append((rid, nid))

    # Shortcuts (fewer, to keep constraints meaningful)
    shortcuts = []
    shortcuts_added = 0
    attempts = 0
    while shortcuts_added < 5 and attempts < 200:
        r1, c1 = rng.randint(0, 9), rng.randint(0, 9)
        r2, c2 = rng.randint(0, 9), rng.randint(0, 9)
        if (r1, c1) in impassable or (r2, c2) in impassable:
            attempts += 1
            continue
        dist = abs(r1 - r2) + abs(c1 - c2)
        if dist >= 3:
            a, b = room_id(r1, c1), room_id(r2, c2)
            if not G.has_edge(a, b):
                G.add_edge(a, b)
                G.add_edge(b, a)
                shortcuts.append((a, b))
                shortcuts_added += 1
        attempts += 1

    # Ensure minimum 2 exits per room
    for node in list(G.nodes()):
        out_deg = G.out_degree(node)
        if out_deg < 2:
            r, c = room_coords(node)
            for dr, dc in [(-1, 0), (1, 0), (0, -1), (0, 1),
                           (-1, -1), (1, 1), (-1, 1), (1, -1)]:
                nr, nc = r + dr, c + dc
                if 0 <= nr < GRID_ROWS and 0 <= nc < GRID_COLS:
                    nid = room_id(nr, nc)
                    if nid in G.nodes() and not G.has_edge(node, nid):
                        G.add_edge(node, nid)
                        if G.out_degree(node) >= 2:
                            break

    # Verify full connectivity
    undirected = G.to_undirected()
    if not nx.is_connected(undirected):
        components = list(nx.connected_components(undirected))
        main = max(components, key=len)
        for comp in components:
            if comp is main:
                continue
            # Connect a node from this component to the nearest node in main
            best = None
            best_dist = float("inf")
            for n1 in comp:
                r1, c1 = room_coords(n1)
                for n2 in main:
                    r2, c2 = room_coords(n2)
                    d = abs(r1 - r2) + abs(c1 - c2)
                    if d < best_dist:
                        best_dist = d
                        best = (n1, n2)
            if best:
                G.add_edge(best[0], best[1])
                G.add_edge(best[1], best[0])

    return G, shortcuts, impassable, oneway_alleys


# ---------------------------------------------------------------------------
# Session Data Generation
# ---------------------------------------------------------------------------
def generate_sessions(G, room_types, variant_name, rng_seed):
    """Generate 50 sessions (10 per archetype) on the given graph."""
    rng = random.Random(rng_seed)
    np_rng = np.random.RandomState(rng_seed)
    sessions = []
    all_nodes = sorted(G.nodes())

    # Precompute room type locations
    type_rooms = defaultdict(list)
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            rid = room_id(r, c)
            if rid in G.nodes():
                type_rooms[room_types[r][c]].append(rid)

    # Precompute nexus room ids
    nexus_ids = set()
    for r, c in NEXUS_POINTS:
        rid = room_id(r, c)
        if rid in G.nodes():
            nexus_ids.add(rid)

    # Precompute rooms near nexus (within manhattan distance 2)
    near_nexus = set()
    for nr, nc in NEXUS_POINTS:
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                if abs(dr) + abs(dc) <= 2:
                    rr, cc = nr + dr, nc + dc
                    if 0 <= rr < GRID_ROWS and 0 <= cc < GRID_COLS:
                        rid = room_id(rr, cc)
                        if rid in G.nodes():
                            near_nexus.add(rid)

    for archetype in ARCHETYPES:
        for session_idx in range(SESSIONS_PER_ARCHETYPE):
            session_duration = rng.randint(SESSION_MIN_MINUTES, SESSION_MAX_MINUTES)
            start_time = datetime(2024, 6, 15, rng.randint(0, 23),
                                  rng.randint(0, 59))

            transitions = []
            commands = []
            current_time = start_time
            end_time = start_time + timedelta(minutes=session_duration)

            # Pick starting room
            current_room = rng.choice(all_nodes)

            visited = {current_room}

            while current_time < end_time:
                # Determine dwell time based on archetype
                dwell = _get_dwell_time(archetype, current_room, room_types,
                                        near_nexus, rng)
                exit_time = current_time + timedelta(seconds=dwell)
                if exit_time > end_time:
                    exit_time = end_time

                transitions.append({
                    "room_id": current_room,
                    "enter_time": current_time.isoformat(),
                    "exit_time": exit_time.isoformat(),
                })

                # Generate commands during dwell
                num_cmds = _get_command_count(archetype, dwell, rng)
                for _ in range(num_cmds):
                    cmd_offset = rng.randint(0, max(1, dwell))
                    cmd_time = current_time + timedelta(seconds=cmd_offset)
                    if cmd_time > exit_time:
                        cmd_time = exit_time
                    cmd_type = _pick_command(archetype, current_room,
                                            room_types, rng)
                    commands.append({
                        "room_id": current_room,
                        "command_type": cmd_type,
                        "timestamp": cmd_time.isoformat(),
                    })

                current_time = exit_time
                if current_time >= end_time:
                    break

                # Pick next room
                next_room = _pick_next_room(
                    archetype, current_room, G, room_types,
                    type_rooms, near_nexus, visited, rng
                )
                if next_room is None:
                    break
                current_room = next_room
                visited.add(current_room)

            sessions.append({
                "archetype": archetype,
                "variant": variant_name,
                "session_duration": session_duration,
                "total_commands": len(commands),
                "unique_rooms_visited": len(visited),
                "transitions": transitions,
                "commands": commands,
            })

    return sessions


def _get_dwell_time(archetype, room, room_types, near_nexus, rng):
    """Return dwell time in seconds based on archetype behavior."""
    r, c = room_coords(room)
    rtype = room_types[r][c]

    base = {
        "explorer": rng.randint(10, 40),
        "social": rng.randint(30, 120),
        "investigator": rng.randint(20, 90),
        "grinder": rng.randint(15, 45),
        "lurker": rng.randint(60, 300),
    }[archetype]

    # Social lingers in taverns/plazas
    if archetype == "social" and rtype in ("tavern", "plaza"):
        base = int(base * rng.uniform(1.5, 3.0))

    # Investigator lingers near nexus
    if archetype == "investigator" and room in near_nexus:
        base = int(base * rng.uniform(2.0, 4.0))

    # Lurker has high idle time everywhere
    if archetype == "lurker":
        base = int(base * rng.uniform(1.2, 2.0))

    return base


def _get_command_count(archetype, dwell_seconds, rng):
    """Return number of commands issued during a room visit."""
    rates = {
        "explorer": 0.08,
        "social": 0.05,
        "investigator": 0.10,
        "grinder": 0.15,
        "lurker": 0.02,
    }
    rate = rates[archetype]
    expected = max(1, int(dwell_seconds * rate))
    return rng.randint(max(0, expected - 1), expected + 2)


def _pick_command(archetype, room, room_types, rng):
    """Pick a command type weighted by archetype."""
    r, c = room_coords(room)
    rtype = room_types[r][c]

    weights = {
        "explorer": {"look": 4, "move": 3, "examine": 2, "take": 1,
                      "inventory": 1, "talk": 0, "wait": 0, "say": 0},
        "social": {"talk": 4, "say": 3, "look": 2, "examine": 1,
                   "wait": 1, "move": 1, "take": 0, "inventory": 0},
        "investigator": {"examine": 5, "look": 4, "talk": 2, "take": 1,
                         "inventory": 2, "move": 1, "wait": 1, "say": 0},
        "grinder": {"move": 3, "take": 4, "inventory": 3, "look": 1,
                    "examine": 0, "talk": 0, "wait": 0, "say": 0},
        "lurker": {"look": 3, "wait": 5, "examine": 2, "inventory": 1,
                   "move": 0, "talk": 0, "take": 0, "say": 0},
    }

    w = weights[archetype]
    cmds = list(w.keys())
    wts = [w[cmd] + 0.1 for cmd in cmds]  # small epsilon to avoid zero
    total = sum(wts)
    probs = [x / total for x in wts]
    return rng.choices(cmds, weights=probs, k=1)[0]


def _pick_next_room(archetype, current, G, room_types, type_rooms,
                    near_nexus, visited, rng):
    """Choose the next room based on archetype movement patterns."""
    neighbors = list(G.successors(current))
    if not neighbors:
        return None

    if archetype == "explorer":
        # Prefer unvisited rooms
        unvisited = [n for n in neighbors if n not in visited]
        if unvisited:
            return rng.choice(unvisited)
        # If all neighbors visited, try path to an unvisited room
        all_nodes = set(G.nodes())
        global_unvisited = list(all_nodes - visited)
        if global_unvisited and rng.random() < 0.6:
            target = rng.choice(global_unvisited)
            try:
                path = nx.shortest_path(G, current, target)
                if len(path) > 1:
                    return path[1]
            except nx.NetworkXNoPath:
                pass
        return rng.choice(neighbors)

    elif archetype == "social":
        # Gravitate toward taverns/plazas
        social_rooms = type_rooms.get("tavern", []) + type_rooms.get("plaza", [])
        social_neighbors = [n for n in neighbors if n in social_rooms]
        if social_neighbors and rng.random() < 0.6:
            return rng.choice(social_neighbors)
        # Sometimes path toward a social room
        if rng.random() < 0.3 and social_rooms:
            target = rng.choice(social_rooms)
            try:
                path = nx.shortest_path(G, current, target)
                if len(path) > 1:
                    return path[1]
            except nx.NetworkXNoPath:
                pass
        return rng.choice(neighbors)

    elif archetype == "investigator":
        # Revisit rooms, especially near nexus
        near_nexus_neighbors = [n for n in neighbors if n in near_nexus]
        if near_nexus_neighbors and rng.random() < 0.5:
            return rng.choice(near_nexus_neighbors)
        # Path toward nexus areas
        if rng.random() < 0.35:
            nexus_rooms = [room_id(r, c) for r, c in NEXUS_POINTS
                          if room_id(r, c) in G.nodes()]
            if nexus_rooms:
                target = rng.choice(nexus_rooms)
                try:
                    path = nx.shortest_path(G, current, target)
                    if len(path) > 1:
                        return path[1]
                except nx.NetworkXNoPath:
                    pass
        # Some revisiting
        if rng.random() < 0.3:
            visited_neighbors = [n for n in neighbors if n in visited]
            if visited_neighbors:
                return rng.choice(visited_neighbors)
        return rng.choice(neighbors)

    elif archetype == "grinder":
        # Repetitive pathing between 3-5 favorite rooms
        if not hasattr(rng, '_grinder_favs'):
            rng._grinder_favs = {}
        key = id(visited)  # unique per session
        if key not in rng._grinder_favs:
            rng._grinder_favs[key] = rng.sample(
                list(G.nodes()), min(5, len(G.nodes()))
            )
        favs = rng._grinder_favs[key]
        fav_neighbors = [n for n in neighbors if n in favs]
        if fav_neighbors and rng.random() < 0.7:
            return rng.choice(fav_neighbors)
        # Path to a favorite
        if rng.random() < 0.5:
            target = rng.choice(favs)
            try:
                path = nx.shortest_path(G, current, target)
                if len(path) > 1:
                    return path[1]
            except nx.NetworkXNoPath:
                pass
        return rng.choice(neighbors)

    elif archetype == "lurker":
        # Slow, random movement
        if rng.random() < 0.4:
            return current  # stay in place (but we'll just pick a neighbor)
        return rng.choice(neighbors)

    return rng.choice(neighbors)


# ---------------------------------------------------------------------------
# Analysis helpers
# ---------------------------------------------------------------------------
def compute_visit_heatmap(sessions, archetype=None):
    """Compute a 10x10 visit frequency matrix."""
    grid = np.zeros((GRID_ROWS, GRID_COLS))
    for s in sessions:
        if archetype and s["archetype"] != archetype:
            continue
        for t in s["transitions"]:
            r, c = room_coords(t["room_id"])
            grid[r][c] += 1
    return grid


def compute_command_heatmap(sessions, archetype=None):
    """Compute a 10x10 command density matrix."""
    grid = np.zeros((GRID_ROWS, GRID_COLS))
    for s in sessions:
        if archetype and s["archetype"] != archetype:
            continue
        for cmd in s["commands"]:
            r, c = room_coords(cmd["room_id"])
            grid[r][c] += 1
    return grid


def compute_temporal_heatmaps(sessions, archetype, num_quartiles=4):
    """Compute visit heatmaps per session quartile for a given archetype."""
    grids = [np.zeros((GRID_ROWS, GRID_COLS)) for _ in range(num_quartiles)]
    for s in sessions:
        if s["archetype"] != archetype:
            continue
        n = len(s["transitions"])
        if n == 0:
            continue
        chunk = max(1, n // num_quartiles)
        for i, t in enumerate(s["transitions"]):
            q = min(i // chunk, num_quartiles - 1)
            r, c = room_coords(t["room_id"])
            grids[q][r][c] += 1
    return grids


# ---------------------------------------------------------------------------
# Visualization
# ---------------------------------------------------------------------------
def draw_topology(ax, G, room_types, shortcuts, variant_name,
                  impassable=None, oneway_alleys=None):
    """Draw the grid topology with room types and connections."""
    if impassable is None:
        impassable = set()

    ax.set_xlim(-0.5, GRID_COLS - 0.5)
    ax.set_ylim(-0.5, GRID_ROWS - 0.5)
    ax.set_aspect("equal")
    ax.set_title(f"Grid Topology — {variant_name}", fontsize=11, fontweight="bold")
    ax.invert_yaxis()

    # Draw connections
    drawn_edges = set()
    for u, v in G.edges():
        if (u, v) in drawn_edges:
            continue
        r1, c1 = room_coords(u)
        r2, c2 = room_coords(v)
        is_shortcut = any((u == a and v == b) or (u == b and v == a)
                          for a, b in shortcuts)
        is_oneway = oneway_alleys and (u, v) in oneway_alleys
        bidir = G.has_edge(v, u)

        color = "#aaaaaa"
        ls = "-"
        lw = 0.5
        if is_shortcut:
            color = "#e74c3c"
            ls = "--"
            lw = 1.0
        if is_oneway or not bidir:
            color = "#e67e22"
            lw = 1.2
            # Draw arrow for one-way
            ax.annotate("", xy=(c2, r2), xytext=(c1, r1),
                        arrowprops=dict(arrowstyle="->", color=color,
                                        lw=lw, ls=ls))
            drawn_edges.add((u, v))
            continue

        ax.plot([c1, c2], [r1, r2], color=color, lw=lw, ls=ls, zorder=1)
        drawn_edges.add((u, v))
        drawn_edges.add((v, u))

    # Draw rooms
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if (r, c) in impassable:
                ax.add_patch(plt.Rectangle((c - 0.4, r - 0.4), 0.8, 0.8,
                             fill=True, facecolor="#1a5276", edgecolor="#1a5276",
                             alpha=0.5, zorder=2))
                ax.text(c, r, "~", ha="center", va="center", fontsize=8,
                        color="white", zorder=3)
                continue

            rtype = room_types[r][c]
            color = ROOM_TYPE_COLORS.get(rtype, "#cccccc")
            is_nexus = (r, c) in NEXUS_POINTS

            marker_size = 0.35
            rect = plt.Rectangle((c - marker_size, r - marker_size),
                                 marker_size * 2, marker_size * 2,
                                 fill=True, facecolor=color,
                                 edgecolor="black" if not is_nexus else "red",
                                 linewidth=1 if not is_nexus else 2.5,
                                 zorder=4)
            ax.add_patch(rect)

            if is_nexus:
                ax.text(c, r, "N", ha="center", va="center", fontsize=7,
                        fontweight="bold", color="white", zorder=5)
            else:
                label = rtype[0].upper()
                ax.text(c, r, label, ha="center", va="center", fontsize=6,
                        color="white", zorder=5)

    ax.set_xticks(range(GRID_COLS))
    ax.set_yticks(range(GRID_ROWS))
    ax.grid(True, alpha=0.15)


def plot_heatmap_on_ax(ax, data, title, cmap="YlOrRd", vmax=None,
                       impassable=None, show_nexus=True):
    """Plot a single heatmap on the given axes."""
    display = data.copy().astype(float)
    if impassable:
        for r, c in impassable:
            display[r][c] = np.nan

    mask = np.isnan(display)
    sns.heatmap(display, ax=ax, cmap=cmap, mask=mask,
                vmin=0, vmax=vmax,
                square=True, cbar=True, cbar_kws={"shrink": 0.6},
                linewidths=0.3, linecolor="#eeeeee",
                xticklabels=range(GRID_COLS),
                yticklabels=range(GRID_ROWS))

    # Mark impassable
    if impassable:
        for r, c in impassable:
            ax.add_patch(plt.Rectangle((c, r), 1, 1, fill=True,
                         facecolor="#1a5276", alpha=0.6))

    # Mark nexus
    if show_nexus:
        for r, c in NEXUS_POINTS:
            ax.plot(c + 0.5, r + 0.5, marker="*", markersize=12,
                    color="red", markeredgecolor="black", markeredgewidth=0.5,
                    zorder=10)

    ax.set_title(title, fontsize=9, fontweight="bold")


def save_fig(fig, name):
    path = os.path.join(OUTPUT_DIR, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  Saved: {path}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    print("=" * 60)
    print("MUD Behavior Heatmap Generator")
    print("=" * 60)

    room_types = assign_room_types()

    # Build grids
    print("\n[1] Building grid variants...")
    G_open, sc_open = build_open_grid()
    G_const, sc_const, impassable, oneway = build_constrained_grid()

    print(f"  Open grid: {G_open.number_of_nodes()} rooms, "
          f"{G_open.number_of_edges()} directed edges, "
          f"{len(sc_open)} shortcuts")
    print(f"  Constrained grid: {G_const.number_of_nodes()} rooms, "
          f"{G_const.number_of_edges()} directed edges, "
          f"{len(sc_const)} shortcuts, {len(impassable)} impassable, "
          f"{len(oneway)} one-way alleys")

    # Verify connectivity
    assert nx.is_weakly_connected(G_open), "Open grid is not connected!"
    assert nx.is_weakly_connected(G_const), "Constrained grid is not connected!"
    print("  Both grids verified fully connected.")

    # Generate sessions
    print("\n[2] Generating session data...")
    sessions_open = generate_sessions(G_open, room_types, "open", SEED)
    sessions_const = generate_sessions(G_const, room_types, "constrained", SEED)
    print(f"  Open: {len(sessions_open)} sessions")
    print(f"  Constrained: {len(sessions_const)} sessions")

    for variant, sessions in [("open", sessions_open),
                              ("constrained", sessions_const)]:
        for arch in ARCHETYPES:
            arch_sessions = [s for s in sessions if s["archetype"] == arch]
            avg_rooms = np.mean([s["unique_rooms_visited"] for s in arch_sessions])
            avg_cmds = np.mean([s["total_commands"] for s in arch_sessions])
            print(f"    {variant}/{arch}: avg {avg_rooms:.1f} unique rooms, "
                  f"{avg_cmds:.1f} commands")

    # -----------------------------------------------------------------------
    # Visualization 1: Grid topology maps
    # -----------------------------------------------------------------------
    print("\n[3] Generating visualizations...")
    print("  [3.1] Grid topology maps...")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 8))
    draw_topology(ax1, G_open, room_types, sc_open, "Variant A (Open)")
    draw_topology(ax2, G_const, room_types, sc_const, "Variant B (Constrained)",
                  impassable=impassable, oneway_alleys=oneway)

    # Legend for room types
    legend_patches = [mpatches.Patch(color=c, label=t.capitalize())
                      for t, c in ROOM_TYPE_COLORS.items()]
    legend_patches.append(Line2D([0], [0], marker="s", color="w",
                                 markerfacecolor="gray", markeredgecolor="red",
                                 markersize=10, label="Nexus Point"))
    legend_patches.append(Line2D([0], [0], color="#e74c3c", ls="--",
                                 lw=1.5, label="Shortcut"))
    legend_patches.append(Line2D([0], [0], color="#e67e22", lw=1.5,
                                 label="One-way"))
    fig.legend(handles=legend_patches, loc="lower center", ncol=7, fontsize=8,
               bbox_to_anchor=(0.5, -0.02))
    fig.suptitle("Grid Topology Comparison", fontsize=14, fontweight="bold")
    save_fig(fig, "01_grid_topology.png")

    # -----------------------------------------------------------------------
    # Visualization 2: Per-archetype heatmaps (2×5 panel)
    # -----------------------------------------------------------------------
    print("  [3.2] Per-archetype heatmaps...")
    fig, axes = plt.subplots(2, 5, figsize=(24, 10))

    for i, arch in enumerate(ARCHETYPES):
        hm_open = compute_visit_heatmap(sessions_open, arch)
        hm_const = compute_visit_heatmap(sessions_const, arch)
        vmax = max(hm_open.max(), hm_const.max())

        plot_heatmap_on_ax(axes[0, i], hm_open,
                           f"{arch.capitalize()} — Open",
                           vmax=vmax)
        plot_heatmap_on_ax(axes[1, i], hm_const,
                           f"{arch.capitalize()} — Constrained",
                           vmax=vmax, impassable=impassable)

    fig.suptitle("Per-Archetype Visit Frequency Heatmaps",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.95])
    save_fig(fig, "02_per_archetype_heatmaps.png")

    # -----------------------------------------------------------------------
    # Visualization 3: Composite overlay
    # -----------------------------------------------------------------------
    print("  [3.3] Composite overlay...")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 8))

    for ax, sessions, label, imp in [
        (ax1, sessions_open, "Open", None),
        (ax2, sessions_const, "Constrained", impassable)
    ]:
        # Build RGB composite: assign each archetype a color channel blend
        composite = np.zeros((GRID_ROWS, GRID_COLS, 3))
        arch_rgb = {
            "explorer": np.array([0.12, 0.47, 0.71]),   # blue
            "social": np.array([1.0, 0.50, 0.05]),       # orange
            "investigator": np.array([0.17, 0.63, 0.17]),# green
            "grinder": np.array([0.84, 0.15, 0.16]),     # red
            "lurker": np.array([0.58, 0.40, 0.74]),      # purple
        }

        for arch in ARCHETYPES:
            hm = compute_visit_heatmap(sessions, arch)
            if hm.max() > 0:
                hm_norm = hm / hm.max()
            else:
                hm_norm = hm
            for r in range(GRID_ROWS):
                for c in range(GRID_COLS):
                    composite[r, c] += hm_norm[r, c] * arch_rgb[arch]

        # Normalize composite to [0, 1]
        if composite.max() > 0:
            composite = composite / composite.max()

        # Mask impassable as dark
        if imp:
            for r, c in imp:
                composite[r, c] = [0.1, 0.15, 0.3]

        ax.imshow(composite, interpolation="nearest", aspect="equal")
        # Nexus markers
        for r, c in NEXUS_POINTS:
            ax.plot(c, r, marker="*", markersize=15, color="white",
                    markeredgecolor="black", markeredgewidth=1, zorder=10)
        ax.set_title(f"Composite Overlay — {label}", fontsize=11,
                     fontweight="bold")
        ax.set_xticks(range(GRID_COLS))
        ax.set_yticks(range(GRID_ROWS))
        ax.grid(True, alpha=0.2, color="white")

    # Legend
    legend_patches = [mpatches.Patch(color=ARCHETYPE_COLORS[a],
                      label=a.capitalize()) for a in ARCHETYPES]
    legend_patches.append(Line2D([0], [0], marker="*", color="w",
                                 markerfacecolor="white", markeredgecolor="black",
                                 markersize=12, label="Nexus"))
    fig.legend(handles=legend_patches, loc="lower center", ncol=6, fontsize=9,
               bbox_to_anchor=(0.5, -0.02))
    fig.suptitle("Composite Archetype Overlay", fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0.03, 1, 0.95])
    save_fig(fig, "03_composite_overlay.png")

    # -----------------------------------------------------------------------
    # Visualization 4: Temporal heatmap (investigator, quartiles)
    # -----------------------------------------------------------------------
    print("  [3.4] Temporal heatmaps (investigator)...")
    fig, axes = plt.subplots(2, 4, figsize=(20, 10))
    quartile_labels = ["Q1 (Early)", "Q2", "Q3", "Q4 (Late)"]

    temp_open = compute_temporal_heatmaps(sessions_open, "investigator")
    temp_const = compute_temporal_heatmaps(sessions_const, "investigator")
    vmax = max(max(q.max() for q in temp_open),
               max(q.max() for q in temp_const))

    for i in range(4):
        plot_heatmap_on_ax(axes[0, i], temp_open[i],
                           f"Open — {quartile_labels[i]}",
                           cmap="Greens", vmax=vmax)
        plot_heatmap_on_ax(axes[1, i], temp_const[i],
                           f"Constrained — {quartile_labels[i]}",
                           cmap="Greens", vmax=vmax, impassable=impassable)

    fig.suptitle("Investigator Temporal Visit Evolution (Session Quartiles)",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.95])
    save_fig(fig, "04_temporal_investigator.png")

    # -----------------------------------------------------------------------
    # Visualization 5: Command density map
    # -----------------------------------------------------------------------
    print("  [3.5] Command density maps...")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 7))
    cmd_open = compute_command_heatmap(sessions_open)
    cmd_const = compute_command_heatmap(sessions_const)
    vmax = max(cmd_open.max(), cmd_const.max())

    plot_heatmap_on_ax(ax1, cmd_open, "Command Density — Open",
                       cmap="inferno", vmax=vmax)
    plot_heatmap_on_ax(ax2, cmd_const, "Command Density — Constrained",
                       cmap="inferno", vmax=vmax, impassable=impassable)

    fig.suptitle("Command Density per Room", fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.95])
    save_fig(fig, "05_command_density.png")

    # -----------------------------------------------------------------------
    # Visualization 6: Nexus proximity analysis
    # -----------------------------------------------------------------------
    print("  [3.6] Nexus proximity analysis...")
    fig, axes = plt.subplots(2, 5, figsize=(24, 10))

    for i, arch in enumerate(ARCHETYPES):
        for row, (sessions, label, imp) in enumerate([
            (sessions_open, "Open", None),
            (sessions_const, "Constrained", impassable)
        ]):
            hm = compute_visit_heatmap(sessions, arch)
            ax = axes[row, i]

            display = hm.copy().astype(float)
            if imp:
                for r, c in imp:
                    display[r][c] = np.nan

            mask = np.isnan(display)
            sns.heatmap(display, ax=ax, cmap="YlOrRd", mask=mask,
                        square=True, cbar=True, cbar_kws={"shrink": 0.5},
                        linewidths=0.3, linecolor="#eeeeee",
                        xticklabels=range(GRID_COLS),
                        yticklabels=range(GRID_ROWS))

            # Nexus markers
            for r, c in NEXUS_POINTS:
                ax.plot(c + 0.5, r + 0.5, marker="*", markersize=14,
                        color="cyan", markeredgecolor="black",
                        markeredgewidth=0.8, zorder=10)

            # Draw proximity circles around nexus
            for r, c in NEXUS_POINTS:
                circle = plt.Circle((c + 0.5, r + 0.5), 2.5, fill=False,
                                    edgecolor="cyan", linewidth=1.5,
                                    linestyle="--", zorder=9)
                ax.add_patch(circle)

            ax.set_title(f"{arch.capitalize()} — {label}", fontsize=8,
                         fontweight="bold")

    fig.suptitle("Nexus Proximity Analysis: Visit Density vs Nexus Locations",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.95])
    save_fig(fig, "06_nexus_proximity.png")

    # -----------------------------------------------------------------------
    # Visualization 7: Difference maps
    # -----------------------------------------------------------------------
    print("  [3.7] Difference maps (constrained - open)...")
    fig, axes = plt.subplots(1, 5, figsize=(24, 5))

    for i, arch in enumerate(ARCHETYPES):
        hm_open = compute_visit_heatmap(sessions_open, arch)
        hm_const = compute_visit_heatmap(sessions_const, arch)

        # Normalize each before subtraction for fair comparison
        if hm_open.max() > 0:
            hm_open_n = hm_open / hm_open.max()
        else:
            hm_open_n = hm_open
        if hm_const.max() > 0:
            hm_const_n = hm_const / hm_const.max()
        else:
            hm_const_n = hm_const

        diff = hm_const_n - hm_open_n

        ax = axes[i]
        vabs = max(abs(diff.min()), abs(diff.max()), 0.01)

        # Mask impassable
        display = diff.copy()
        for r, c in impassable:
            display[r][c] = np.nan
        mask = np.isnan(display)

        sns.heatmap(display, ax=ax, cmap="RdBu_r", mask=mask,
                    vmin=-vabs, vmax=vabs,
                    square=True, cbar=True, cbar_kws={"shrink": 0.6},
                    linewidths=0.3, linecolor="#eeeeee",
                    xticklabels=range(GRID_COLS),
                    yticklabels=range(GRID_ROWS),
                    center=0)

        # Nexus markers
        for r, c in NEXUS_POINTS:
            ax.plot(c + 0.5, r + 0.5, marker="*", markersize=12,
                    color="lime", markeredgecolor="black",
                    markeredgewidth=0.5, zorder=10)

        ax.set_title(f"{arch.capitalize()}", fontsize=10, fontweight="bold")

    fig.suptitle("Difference Maps (Constrained − Open, Normalized)\n"
                 "Red = more traffic in constrained, Blue = less traffic",
                 fontsize=13, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.90])
    save_fig(fig, "07_difference_maps.png")

    # -----------------------------------------------------------------------
    # Summary statistics
    # -----------------------------------------------------------------------
    print("\n[4] Summary Analysis")
    print("-" * 60)

    for arch in ARCHETYPES:
        hm_open = compute_visit_heatmap(sessions_open, arch)
        hm_const = compute_visit_heatmap(sessions_const, arch)

        if hm_open.max() > 0:
            hm_open_n = hm_open / hm_open.max()
        else:
            hm_open_n = hm_open
        if hm_const.max() > 0:
            hm_const_n = hm_const / hm_const.max()
        else:
            hm_const_n = hm_const

        # Correlation between open and constrained patterns
        valid_mask = np.ones((GRID_ROWS, GRID_COLS), dtype=bool)
        for r, c in impassable:
            valid_mask[r][c] = False
        open_vals = hm_open_n[valid_mask].flatten()
        const_vals = hm_const_n[valid_mask].flatten()
        if open_vals.std() > 0 and const_vals.std() > 0:
            corr = np.corrcoef(open_vals, const_vals)[0, 1]
        else:
            corr = 0.0

        # Nexus proximity density
        nexus_density_open = 0
        nexus_density_const = 0
        nexus_count = 0
        for nr, nc in NEXUS_POINTS:
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    if abs(dr) + abs(dc) <= 2:
                        rr, cc = nr + dr, nc + dc
                        if 0 <= rr < GRID_ROWS and 0 <= cc < GRID_COLS:
                            nexus_density_open += hm_open_n[rr][cc]
                            if (rr, cc) not in impassable:
                                nexus_density_const += hm_const_n[rr][cc]
                            nexus_count += 1

        print(f"\n  {arch.upper()}:")
        print(f"    Pattern correlation (open vs constrained): {corr:.3f}")
        print(f"    Nexus proximity density (open):            "
              f"{nexus_density_open / max(nexus_count, 1):.3f}")
        print(f"    Nexus proximity density (constrained):     "
              f"{nexus_density_const / max(nexus_count, 1):.3f}")

        # Coverage
        open_coverage = np.count_nonzero(hm_open) / 100
        const_coverage = np.count_nonzero(hm_const) / (100 - len(impassable))
        print(f"    Room coverage (open):        {open_coverage:.0%}")
        print(f"    Room coverage (constrained): {const_coverage:.0%}")

    # Final interpretation
    print("\n" + "=" * 60)
    print("INTERPRETATION")
    print("=" * 60)

    inv_open = compute_visit_heatmap(sessions_open, "investigator")
    inv_const = compute_visit_heatmap(sessions_const, "investigator")
    if inv_open.max() > 0:
        inv_open_n = inv_open / inv_open.max()
    else:
        inv_open_n = inv_open
    if inv_const.max() > 0:
        inv_const_n = inv_const / inv_const.max()
    else:
        inv_const_n = inv_const

    valid = np.ones((GRID_ROWS, GRID_COLS), dtype=bool)
    for r, c in impassable:
        valid[r][c] = False
    corr = np.corrcoef(inv_open_n[valid].flatten(),
                       inv_const_n[valid].flatten())[0, 1]

    print(f"\n  Investigator pattern correlation: {corr:.3f}")
    if corr > 0.7:
        print("  -> HIGH correlation: Investigator behavioral shape PERSISTS")
        print("     across topologies. Behavioral heatmaps are a robust")
        print("     classification signal for this archetype.")
    elif corr > 0.4:
        print("  -> MODERATE correlation: Investigator shape partially")
        print("     survives topology. Chokepoints pull some traffic but")
        print("     nexus-seeking behavior remains visible.")
    else:
        print("  -> LOW correlation: Topology DOMINATES investigator behavior.")
        print("     Chaos Monkey must normalize for chokepoint effects.")

    # Identify topology-sensitive rooms
    diff = inv_const_n - inv_open_n
    topo_rooms = []
    arch_rooms = []
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if (r, c) in impassable:
                continue
            if abs(diff[r][c]) > 0.3:
                topo_rooms.append((r, c, diff[r][c]))
            elif abs(diff[r][c]) < 0.1 and inv_open_n[r][c] > 0.3:
                arch_rooms.append((r, c))

    print(f"\n  Topology-sensitive rooms (investigator, |diff| > 0.3):")
    for r, c, d in sorted(topo_rooms, key=lambda x: -abs(x[2]))[:10]:
        direction = "gained" if d > 0 else "lost"
        print(f"    ({r},{c}) {room_types[r][c]:>10s}: {direction} "
              f"{abs(d):.2f} normalized traffic")

    print(f"\n  Archetype-stable rooms (investigator, |diff| < 0.1, "
          f"density > 0.3):")
    for r, c in arch_rooms[:10]:
        print(f"    ({r},{c}) {room_types[r][c]:>10s}: stable at "
              f"{inv_open_n[r][c]:.2f}")

    print(f"\n  Topology-sensitive rooms are POOR corruption candidates")
    print(f"  (high traffic is structural, not investigative).")
    print(f"  Archetype-stable rooms are GOOD corruption candidates")
    print(f"  (traffic reflects genuine behavioral signal).")

    print(f"\n  All outputs saved to: {OUTPUT_DIR}/")
    print("=" * 60)


if __name__ == "__main__":
    main()
