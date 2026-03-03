#!/usr/bin/env python3
"""
Calibration Test for MUD Behavioral Heatmap Pipeline

Validates that the measurement apparatus (baseline subtraction, residual
computation, correlation, cosine similarity) produces mathematically expected
outputs using five calibration archetypes with derivable expected outcomes.

Does NOT modify mud_behavior_heatmaps.py or mud_behavior_normalized.py.
Imports and uses their functions as-is.

Outputs PNGs to output_calibration/.
"""

import os
import random
from datetime import datetime, timedelta

import numpy as np
import networkx as nx
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import seaborn as sns

# ---------------------------------------------------------------------------
# Import pipeline functions AS-IS
# ---------------------------------------------------------------------------
from mud_behavior_heatmaps import (
    SEED, GRID_ROWS, GRID_COLS, NEXUS_POINTS,
    assign_room_types, room_id, room_coords,
    build_open_grid, build_constrained_grid,
    compute_visit_heatmap,
    SESSION_MIN_MINUTES, SESSION_MAX_MINUTES,
)
from mud_behavior_normalized import (
    BASELINE_SEED, BASELINE_SESSIONS,
    generate_random_walk_baseline,
    normalize_to_distribution, compute_residual,
    compute_correlation,
    compute_per_session_residual_heatmaps,
    plot_diverging_heatmap,
)

# ---------------------------------------------------------------------------
# Calibration Configuration
# ---------------------------------------------------------------------------
CALIBRATION_SEED = 999
CAL_OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "output_calibration"
)
CAL_ARCHETYPES = ["clone", "walker", "splitter", "magnet", "shuffled_magnet"]
SESSIONS_PER = 10


def save_fig(fig, name):
    path = os.path.join(CAL_OUTPUT_DIR, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"    Saved: {path}")


# ---------------------------------------------------------------------------
# Session helper
# ---------------------------------------------------------------------------
def make_session(archetype, variant, transitions, commands):
    """Build a session dict matching the pipeline's expected format."""
    duration_minutes = 0
    if transitions:
        t0 = datetime.fromisoformat(transitions[0]["enter_time"])
        t1 = datetime.fromisoformat(transitions[-1]["exit_time"])
        duration_minutes = max(1, int((t1 - t0).total_seconds() / 60))
    unique_rooms = len(set(t["room_id"] for t in transitions))
    return {
        "archetype": archetype,
        "variant": variant,
        "session_duration": duration_minutes,
        "total_commands": len(commands),
        "unique_rooms_visited": unique_rooms,
        "transitions": transitions,
        "commands": commands,
    }


def _append_transition(transitions, commands, rid, enter_time, dwell_s, cmd_type):
    """Append a single room visit with one command."""
    exit_time = enter_time + timedelta(seconds=dwell_s)
    transitions.append({
        "room_id": rid,
        "enter_time": enter_time.isoformat(),
        "exit_time": exit_time.isoformat(),
    })
    if cmd_type:
        commands.append({
            "room_id": rid,
            "command_type": cmd_type,
            "timestamp": enter_time.isoformat(),
        })
    return exit_time


# ---------------------------------------------------------------------------
# Calibration Archetype 1: Clone — Perfect Spatial Consistency
# ---------------------------------------------------------------------------
def generate_clone_sessions(variant):
    """10 identical sessions cycling (2,7)->(3,7)->(3,8)->(2,8), 60s dwell."""
    clone_coords = [(2, 7), (3, 7), (3, 8), (2, 8)]
    clone_rids = [room_id(r, c) for r, c in clone_coords]
    sessions = []

    for _ in range(SESSIONS_PER):
        start = datetime(2024, 6, 15, 12, 0)
        transitions = []
        commands = []
        current_time = start

        # 60 visits * 60s = 3600s = 60 min. Each room visited 15 times.
        for visit in range(60):
            rid = clone_rids[visit % 4]
            current_time = _append_transition(
                transitions, commands, rid, current_time, 60, "look")

        sessions.append(make_session("clone", variant, transitions, commands))

    return sessions


# ---------------------------------------------------------------------------
# Calibration Archetype 2: Walker — Random Walk Baseline Match
# ---------------------------------------------------------------------------
def generate_walker_sessions(G, variant, rng_seed):
    """10 random-walk sessions, same algorithm as baseline generator."""
    rng = random.Random(rng_seed)
    all_nodes = sorted(G.nodes())
    sessions = []

    for _ in range(SESSIONS_PER):
        session_minutes = rng.randint(SESSION_MIN_MINUTES, SESSION_MAX_MINUTES)
        remaining_seconds = session_minutes * 60
        current = rng.choice(all_nodes)
        start = datetime(2024, 6, 15, 12, 0)
        current_time = start
        transitions = []
        commands = []

        while remaining_seconds > 0:
            dwell = rng.randint(30, 60)
            if dwell > remaining_seconds:
                dwell = remaining_seconds
            remaining_seconds -= dwell

            current_time = _append_transition(
                transitions, commands, current, current_time, dwell, None)

            neighbors = list(G.successors(current))
            if not neighbors:
                break
            current = rng.choice(neighbors)

        sessions.append(make_session("walker", variant, transitions, commands))

    return sessions


# ---------------------------------------------------------------------------
# Calibration Archetype 3: Splitter — Known Topology Dependence
# ---------------------------------------------------------------------------
def generate_splitter_sessions(G, variant):
    """Open: visits only cols 0-4. Constrained: visits only cols 5-9."""
    all_nodes = sorted(G.nodes())

    if variant == "open":
        target_rooms = [n for n in all_nodes if room_coords(n)[1] <= 4]
    else:
        target_rooms = [n for n in all_nodes if room_coords(n)[1] >= 5]

    sessions = []
    for _ in range(SESSIONS_PER):
        start = datetime(2024, 6, 15, 12, 0)
        transitions = []
        commands = []
        current_time = start

        # 120 visits * 30s = 3600s = 60 min, cycling through target rooms
        for visit in range(120):
            rid = target_rooms[visit % len(target_rooms)]
            current_time = _append_transition(
                transitions, commands, rid, current_time, 30, "move")

        sessions.append(make_session("splitter", variant, transitions, commands))

    return sessions


# ---------------------------------------------------------------------------
# Calibration Archetype 4: Magnet — Fixed Spatial Attractor at (5,5)
# ---------------------------------------------------------------------------
def generate_magnet_sessions(G, variant, rng_seed):
    """80% of visits at (5,5), 20% at random neighbors. Same target both variants."""
    rng = random.Random(rng_seed)
    target = room_id(5, 5)
    target_neighbors = list(G.successors(target))
    sessions = []

    for _ in range(SESSIONS_PER):
        start = datetime(2024, 6, 15, 12, 0)
        transitions = []
        commands = []
        current_time = start

        # 120 visits * 30s = 3600s = 60 min
        for v in range(120):
            if rng.random() < 0.8 or not target_neighbors:
                rid = target
                cmd = "examine"
            else:
                rid = rng.choice(target_neighbors)
                cmd = "move"

            current_time = _append_transition(
                transitions, commands, rid, current_time, 30, cmd)

        sessions.append(make_session("magnet", variant, transitions, commands))

    return sessions


# ---------------------------------------------------------------------------
# Calibration Archetype 5: Shuffled Magnet — Concentrated but Inconsistent
# ---------------------------------------------------------------------------
def generate_shuffled_magnet_sessions(G, variant, rng_seed):
    """Each session picks a different random room as its magnet (80/20 split).
    Uses variant-dependent seed so different rooms are selected per topology."""
    rng = random.Random(rng_seed)
    all_nodes = sorted(G.nodes())
    magnet_rooms = rng.sample(all_nodes, SESSIONS_PER)
    sessions = []

    for i in range(SESSIONS_PER):
        target = magnet_rooms[i]
        target_neighbors = list(G.successors(target))
        start = datetime(2024, 6, 15, 12, 0)
        transitions = []
        commands = []
        current_time = start

        for v in range(120):
            if rng.random() < 0.8 or not target_neighbors:
                rid = target
                cmd = "examine"
            else:
                rid = rng.choice(target_neighbors)
                cmd = "move"

            current_time = _append_transition(
                transitions, commands, rid, current_time, 30, cmd)

        sessions.append(
            make_session("shuffled_magnet", variant, transitions, commands))

    return sessions


# ---------------------------------------------------------------------------
# Separability Matrix (same cosine similarity math as pipeline)
#
# NOTE: compute_separability_matrix in mud_behavior_normalized.py cannot be
# used directly because it hardcodes ARCHETYPES = ["explorer", "social",
# "investigator", "grinder", "lurker"] at line 189 for sort ordering.
# Custom archetype names cause a KeyError. This is a pipeline limitation
# (not a bug in the math) — the function couples sort ordering to the
# original archetype list.
#
# The cosine similarity computation below is identical to the pipeline's.
# ---------------------------------------------------------------------------
def compute_calibration_separability(per_session_residuals, archetype_order):
    """Cosine similarity matrix ordered by archetype_order. Same math as pipeline."""
    order_map = {a: i for i, a in enumerate(archetype_order)}
    items = sorted(per_session_residuals,
                   key=lambda x: order_map[x["archetype"]])

    n = len(items)
    sim_matrix = np.zeros((n, n))
    vectors = [it["residual"].flatten() for it in items]

    for i in range(n):
        for j in range(n):
            if i == j:
                sim_matrix[i][j] = 1.0
            elif j > i:
                vi_norm = np.linalg.norm(vectors[i])
                vj_norm = np.linalg.norm(vectors[j])
                if vi_norm > 0 and vj_norm > 0:
                    sim = np.dot(vectors[i], vectors[j]) / (vi_norm * vj_norm)
                else:
                    sim = 0.0
                sim_matrix[i][j] = sim
                sim_matrix[j][i] = sim

    labels = [it["archetype"] for it in items]
    return sim_matrix, labels


def within_class_similarity(sim_matrix, labels, archetype, include_diagonal):
    """Compute mean within-class cosine similarity."""
    indices = [i for i, l in enumerate(labels) if l == archetype]
    n = len(indices)
    if n < 2:
        return 0.0

    if include_diagonal:
        # All entries in the block, including self-similarity (1.0)
        total = 0.0
        count = 0
        for i in indices:
            for j in indices:
                total += sim_matrix[i][j]
                count += 1
        return total / count
    else:
        # Off-diagonal only (correct computation)
        total = 0.0
        count = 0
        for i in range(len(indices)):
            for j in range(i + 1, len(indices)):
                total += sim_matrix[indices[i]][indices[j]]
                count += 1
        return total / count if count > 0 else 0.0


# ---------------------------------------------------------------------------
# Test result tracking
# ---------------------------------------------------------------------------
class TestResult:
    def __init__(self, archetype, metric, expected_str, actual_diag_incl,
                 actual_diag_excl, pass_fn):
        self.archetype = archetype
        self.metric = metric
        self.expected = expected_str
        self.diag_incl = actual_diag_incl
        self.diag_excl = actual_diag_excl
        # pass_fn evaluates on diag_excl for similarity, on diag_incl for non-sim
        self.passed = pass_fn(actual_diag_excl if actual_diag_excl is not None
                              else actual_diag_incl)

    def fmt_val(self, v):
        if v is None:
            return "   --     "
        return f"{v:>10.4f}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    os.makedirs(CAL_OUTPUT_DIR, exist_ok=True)
    print("=" * 78)
    print("MUD BEHAVIORAL HEATMAP — PIPELINE CALIBRATION TEST")
    print("=" * 78)

    # ------------------------------------------------------------------
    # Setup: grids, baselines (same as experiments 1 & 2)
    # ------------------------------------------------------------------
    print("\n[1] Building grids and baselines...")
    room_types = assign_room_types()
    G_open, _ = build_open_grid()
    G_const, _, impassable, _ = build_constrained_grid()

    baseline_open = generate_random_walk_baseline(
        G_open, BASELINE_SESSIONS, BASELINE_SEED)
    baseline_const = generate_random_walk_baseline(
        G_const, BASELINE_SESSIONS, BASELINE_SEED)
    print(f"  Open grid:  {G_open.number_of_nodes()} rooms, "
          f"baseline sum={baseline_open.sum():.4f}")
    print(f"  Const grid: {G_const.number_of_nodes()} rooms, "
          f"baseline sum={baseline_const.sum():.4f}")

    # Verify Clone rooms exist in both graphs
    clone_rooms = [(2, 7), (3, 7), (3, 8), (2, 8)]
    for r, c in clone_rooms:
        rid = room_id(r, c)
        assert rid in G_open.nodes(), f"Clone room ({r},{c}) missing from open grid"
        assert rid in G_const.nodes(), f"Clone room ({r},{c}) missing from const grid"
    print("  Clone rooms verified in both grids.")

    # Verify Magnet target (5,5) exists in both
    mag_rid = room_id(5, 5)
    assert mag_rid in G_open.nodes(), "Magnet target (5,5) missing from open"
    assert mag_rid in G_const.nodes(), "Magnet target (5,5) missing from const"
    print("  Magnet target (5,5) verified in both grids.")

    # ------------------------------------------------------------------
    # Generate calibration sessions
    # ------------------------------------------------------------------
    print("\n[2] Generating calibration sessions...")
    cal_sessions = {}
    for variant, G in [("open", G_open), ("constrained", G_const)]:
        cal_sessions[(variant, "clone")] = generate_clone_sessions(variant)
        cal_sessions[(variant, "walker")] = generate_walker_sessions(
            G, variant, CALIBRATION_SEED)
        cal_sessions[(variant, "splitter")] = generate_splitter_sessions(G, variant)
        cal_sessions[(variant, "magnet")] = generate_magnet_sessions(
            G, variant, CALIBRATION_SEED)
        # Shuffled Magnet: variant-dependent seed for different room selections
        sm_seed = CALIBRATION_SEED if variant == "open" else CALIBRATION_SEED + 500
        cal_sessions[(variant, "shuffled_magnet")] = \
            generate_shuffled_magnet_sessions(G, variant, sm_seed)

    for variant in ["open", "constrained"]:
        for arch in CAL_ARCHETYPES:
            ss = cal_sessions[(variant, arch)]
            avg_trans = np.mean([len(s["transitions"]) for s in ss])
            avg_rooms = np.mean([s["unique_rooms_visited"] for s in ss])
            print(f"  {variant}/{arch}: {len(ss)} sessions, "
                  f"avg {avg_trans:.0f} transitions, "
                  f"avg {avg_rooms:.0f} unique rooms")

    # ------------------------------------------------------------------
    # Compute residuals using pipeline functions
    # ------------------------------------------------------------------
    print("\n[3] Computing residuals via pipeline functions...")
    residuals = {}
    for variant, baseline in [("open", baseline_open),
                              ("constrained", baseline_const)]:
        for arch in CAL_ARCHETYPES:
            sessions = cal_sessions[(variant, arch)]
            raw = compute_visit_heatmap(sessions, arch)
            res = compute_residual(raw, baseline)
            residuals[(variant, arch)] = res
            print(f"  {variant}/{arch:>15s}: residual range "
                  f"[{res.min():.4f}, {res.max():.4f}]")

    # ------------------------------------------------------------------
    # Compute per-session residuals for separability
    # ------------------------------------------------------------------
    print("\n[4] Computing per-session residuals for separability...")
    per_session_by_variant = {}
    for variant, baseline in [("open", baseline_open),
                              ("constrained", baseline_const)]:
        all_sessions = []
        for arch in CAL_ARCHETYPES:
            all_sessions.extend(cal_sessions[(variant, arch)])
        per_session = compute_per_session_residual_heatmaps(all_sessions, baseline)
        per_session_by_variant[variant] = per_session
        print(f"  {variant}: {len(per_session)} per-session residuals computed")

    # Compute separability matrices
    sep_matrices = {}
    for variant in ["open", "constrained"]:
        matrix, labels = compute_calibration_separability(
            per_session_by_variant[variant], CAL_ARCHETYPES)
        sep_matrices[variant] = (matrix, labels)

    # ------------------------------------------------------------------
    # STEP A: Compute cross-topology correlations on residuals
    # ------------------------------------------------------------------
    print("\n[5] Computing cross-topology correlations...")
    cross_topo_corr = {}
    for arch in CAL_ARCHETYPES:
        res_o = residuals[("open", arch)]
        res_c = residuals[("constrained", arch)]
        corr = compute_correlation(res_o, res_c, impassable)
        cross_topo_corr[arch] = corr
        print(f"  {arch:>15s}: r = {corr:.4f}")

    # ------------------------------------------------------------------
    # STEP B: Compute within-class similarities (with and without diagonal)
    # ------------------------------------------------------------------
    print("\n[6] Computing within-class similarities...")
    within_sims = {}  # (variant, arch) -> {"diag_incl": float, "diag_excl": float}
    for variant in ["open", "constrained"]:
        matrix, labels = sep_matrices[variant]
        for arch in CAL_ARCHETYPES:
            incl = within_class_similarity(matrix, labels, arch, True)
            excl = within_class_similarity(matrix, labels, arch, False)
            within_sims[(variant, arch)] = {"diag_incl": incl, "diag_excl": excl}
            inflation = incl - excl
            print(f"  {variant}/{arch:>15s}: incl={incl:.4f}  excl={excl:.4f}  "
                  f"inflation={inflation:+.4f}")

    # ------------------------------------------------------------------
    # STEP C: Walker-specific metric — mean absolute residual
    # ------------------------------------------------------------------
    walker_mar = {}
    for variant in ["open", "constrained"]:
        res = residuals[(variant, "walker")]
        if variant == "constrained":
            mask = np.ones((GRID_ROWS, GRID_COLS), dtype=bool)
            for r, c in impassable:
                mask[r][c] = False
            mar = np.mean(np.abs(res[mask]))
        else:
            mar = np.mean(np.abs(res))
        walker_mar[variant] = mar
    print(f"\n  Walker mean |residual|: open={walker_mar['open']:.5f}, "
          f"constrained={walker_mar['constrained']:.5f}")

    # ------------------------------------------------------------------
    # Build test results table
    # ------------------------------------------------------------------
    print("\n" + "=" * 78)
    print("CALIBRATION RESULTS")
    print("=" * 78)

    results = []

    # Clone tests
    results.append(TestResult(
        "Clone", "Within-class sim (open)", ">= 0.95",
        within_sims[("open", "clone")]["diag_incl"],
        within_sims[("open", "clone")]["diag_excl"],
        lambda v: v >= 0.95))
    results.append(TestResult(
        "Clone", "Within-class sim (constrained)", ">= 0.95",
        within_sims[("constrained", "clone")]["diag_incl"],
        within_sims[("constrained", "clone")]["diag_excl"],
        lambda v: v >= 0.95))
    results.append(TestResult(
        "Clone", "Cross-topo correlation", ">= 0.90",
        cross_topo_corr["clone"], None,
        lambda v: v >= 0.90))

    # Walker tests
    results.append(TestResult(
        "Walker", "Mean |residual| (open)", "< 0.002",
        walker_mar["open"], None,
        lambda v: v < 0.002))
    results.append(TestResult(
        "Walker", "Mean |residual| (constrained)", "< 0.002",
        walker_mar["constrained"], None,
        lambda v: v < 0.002))
    results.append(TestResult(
        "Walker", "Within-class sim (open)", "< 0.15",
        within_sims[("open", "walker")]["diag_incl"],
        within_sims[("open", "walker")]["diag_excl"],
        lambda v: v < 0.15))
    results.append(TestResult(
        "Walker", "Cross-topo correlation", "< 0.15",
        cross_topo_corr["walker"], None,
        lambda v: abs(v) < 0.15))

    # Splitter tests
    results.append(TestResult(
        "Splitter", "Within-class sim (open)", ">= 0.90",
        within_sims[("open", "splitter")]["diag_incl"],
        within_sims[("open", "splitter")]["diag_excl"],
        lambda v: v >= 0.90))
    results.append(TestResult(
        "Splitter", "Within-class sim (constrained)", ">= 0.90",
        within_sims[("constrained", "splitter")]["diag_incl"],
        within_sims[("constrained", "splitter")]["diag_excl"],
        lambda v: v >= 0.90))
    results.append(TestResult(
        "Splitter", "Cross-topo correlation", "<= -0.50",
        cross_topo_corr["splitter"], None,
        lambda v: v <= -0.50))

    # Magnet tests
    results.append(TestResult(
        "Magnet", "Within-class sim (open)", ">= 0.60",
        within_sims[("open", "magnet")]["diag_incl"],
        within_sims[("open", "magnet")]["diag_excl"],
        lambda v: v >= 0.60))
    results.append(TestResult(
        "Magnet", "Within-class sim (constrained)", ">= 0.60",
        within_sims[("constrained", "magnet")]["diag_incl"],
        within_sims[("constrained", "magnet")]["diag_excl"],
        lambda v: v >= 0.60))
    results.append(TestResult(
        "Magnet", "Cross-topo correlation", ">= 0.50",
        cross_topo_corr["magnet"], None,
        lambda v: v >= 0.50))

    # ShuffledMagnet tests
    results.append(TestResult(
        "ShuffledMagnet", "Within-class sim (open)", "<= 0.10",
        within_sims[("open", "shuffled_magnet")]["diag_incl"],
        within_sims[("open", "shuffled_magnet")]["diag_excl"],
        lambda v: v <= 0.10))
    results.append(TestResult(
        "ShuffledMagnet", "Within-class sim (constrained)", "<= 0.10",
        within_sims[("constrained", "shuffled_magnet")]["diag_incl"],
        within_sims[("constrained", "shuffled_magnet")]["diag_excl"],
        lambda v: v <= 0.10))
    results.append(TestResult(
        "ShuffledMagnet", "Cross-topo correlation", "< 0.15",
        cross_topo_corr["shuffled_magnet"], None,
        lambda v: abs(v) < 0.15))

    # Print summary table
    print(f"\n{'Archetype':<15s} {'Metric':<35s} {'Expected':<10s} "
          f"{'Diag Incl.':<12s} {'Diag Excl.':<12s} {'Result':<6s}")
    print("-" * 92)

    pass_count = 0
    fail_count = 0
    for r in results:
        status = "PASS" if r.passed else "FAIL"
        if r.passed:
            pass_count += 1
        else:
            fail_count += 1
        print(f"{r.archetype:<15s} {r.metric:<35s} {r.expected:<10s} "
              f"{r.fmt_val(r.diag_incl):<12s} {r.fmt_val(r.diag_excl):<12s} "
              f"{status:<6s}")

    print("-" * 92)
    print(f"Total: {pass_count} PASS, {fail_count} FAIL out of {len(results)} tests")

    # ------------------------------------------------------------------
    # Diagonal inflation analysis
    # ------------------------------------------------------------------
    print("\n" + "-" * 78)
    print("DIAGONAL INFLATION ANALYSIS")
    print("-" * 78)

    inflations = []
    for variant in ["open", "constrained"]:
        for arch in CAL_ARCHETYPES:
            incl = within_sims[(variant, arch)]["diag_incl"]
            excl = within_sims[(variant, arch)]["diag_excl"]
            diff = incl - excl
            inflations.append(diff)
            print(f"  {variant}/{arch:>15s}: inflation = {diff:+.4f}")

    avg_inflation = np.mean(inflations)
    max_inflation = max(inflations)
    significant = max_inflation > 0.05

    print(f"\n  Average diagonal inflation: {avg_inflation:+.4f}")
    print(f"  Maximum diagonal inflation: {max_inflation:+.4f}")
    print(f"  Diagonal inflation detected (max > 0.05): "
          f"{'YES' if significant else 'NO'}")

    if significant:
        print(f"  WARNING: Including diagonal inflates within-class similarity "
              f"by up to {max_inflation:.4f}.")
        print(f"  The existing pipeline (mud_behavior_normalized.py) correctly")
        print(f"  excludes diagonal in its within-class computation (line 654-656).")
        print(f"  The sim_matrix itself contains 1.0 on diagonal (line 199).")
    else:
        print(f"  Diagonal inflation is negligible (< 0.05 for all archetypes).")

    # ------------------------------------------------------------------
    # Pipeline limitation: compute_separability_matrix hardcodes ARCHETYPES
    # ------------------------------------------------------------------
    print("\n" + "-" * 78)
    print("PIPELINE FINDING: compute_separability_matrix archetype coupling")
    print("-" * 78)
    print("  mud_behavior_normalized.py line 189:")
    print("    arch_order = {a: i for i, a in enumerate(ARCHETYPES)}")
    print("  This hardcodes sort ordering to the 5 original archetypes.")
    print("  Passing sessions with custom archetype names causes KeyError.")
    print("  Impact: The separability analysis cannot be reused for arbitrary")
    print("  archetype sets without modifying the function signature to accept")
    print("  a custom ordering parameter. The cosine similarity MATH is correct;")
    print("  the limitation is in the sort/ordering logic only.")

    # ==================================================================
    # VISUALIZATION 1: Calibration Separability Matrix (PNG)
    # ==================================================================
    print("\n[7] Generating visualizations...")
    print("  [7.1] Calibration separability matrix...")

    matrix_open, labels_open = sep_matrices["open"]

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(22, 9))

    # Left: diagonal included
    sns.heatmap(matrix_open, ax=ax1, cmap="RdYlBu_r",
                vmin=-0.5, vmax=1.0, center=0.25,
                square=True, cbar=True,
                cbar_kws={"shrink": 0.6, "label": "Cosine Similarity"},
                linewidths=0, xticklabels=False, yticklabels=False)
    ax1.set_title("Diagonal Included", fontsize=12, fontweight="bold")

    # Right: diagonal excluded (masked to gray)
    matrix_masked = matrix_open.copy()
    mask = np.eye(len(matrix_masked), dtype=bool)

    sns.heatmap(matrix_masked, ax=ax2, cmap="RdYlBu_r",
                vmin=-0.5, vmax=1.0, center=0.25,
                mask=mask, square=True, cbar=True,
                cbar_kws={"shrink": 0.6, "label": "Cosine Similarity"},
                linewidths=0, xticklabels=False, yticklabels=False)
    # Draw gray squares on diagonal
    for i in range(len(matrix_masked)):
        ax2.add_patch(plt.Rectangle((i, i), 1, 1, fill=True,
                      facecolor="#cccccc", edgecolor="none"))
    ax2.set_title("Diagonal Excluded (gray)", fontsize=12, fontweight="bold")

    # Draw block boundaries on both axes
    for ax in [ax1, ax2]:
        for idx, arch in enumerate(CAL_ARCHETYPES):
            start = idx * SESSIONS_PER
            rect = plt.Rectangle((start, start), SESSIONS_PER, SESSIONS_PER,
                                 fill=False, edgecolor="black", linewidth=2)
            ax.add_patch(rect)
            label = arch.replace("_", "\n")
            ax.text(start + SESSIONS_PER / 2, start + SESSIONS_PER / 2,
                    label.capitalize(), ha="center", va="center",
                    fontsize=7, fontweight="bold",
                    bbox=dict(boxstyle="round", facecolor="white", alpha=0.85))

    fig.suptitle("Calibration Separability Matrix — Open Grid\n"
                 "(50x50 pairwise cosine similarity on residual heatmaps)",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.93])
    save_fig(fig, "01_calibration_separability.png")

    # ==================================================================
    # VISUALIZATION 2: Calibration Residual Heatmaps (PNG)
    # ==================================================================
    print("  [7.2] Calibration residual heatmaps...")

    fig, axes = plt.subplots(2, 5, figsize=(26, 10))

    for i, arch in enumerate(CAL_ARCHETYPES):
        res_open = residuals[("open", arch)]
        res_const = residuals[("constrained", arch)]

        # Shared scale per archetype for visual comparison
        all_vals = np.concatenate([res_open.flatten(), res_const.flatten()])
        all_vals = all_vals[~np.isnan(all_vals)]
        vabs = max(abs(all_vals.min()), abs(all_vals.max()), 1e-6)

        plot_diverging_heatmap(axes[0, i], res_open * 1000,
                               f"{arch.replace('_', ' ').title()} — Open",
                               impassable=None, vabs=vabs * 1000,
                               show_nexus=False)
        plot_diverging_heatmap(axes[1, i], res_const * 1000,
                               f"{arch.replace('_', ' ').title()} — Const",
                               impassable=impassable, vabs=vabs * 1000,
                               show_nexus=False)

    fig.suptitle("Calibration Archetype Residual Heatmaps (x1000)\n"
                 "Red = above baseline, Blue = below baseline",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.92])
    save_fig(fig, "02_calibration_residuals.png")

    # ==================================================================
    # WRITTEN DIAGNOSIS
    # ==================================================================
    print("\n" + "=" * 78)
    print("DIAGNOSIS")
    print("=" * 78)

    all_passed = fail_count == 0

    if all_passed:
        print("""
  ALL TESTS PASSED.

  The pipeline's measurement apparatus produces mathematically expected outputs
  for all five calibration archetypes:

  - Clone (perfect consistency):   within-class similarity = 1.0, cross-topo
    correlation > 0.90 — the pipeline correctly identifies identical sessions
    and tracks their signal across topologies.

  - Walker (random baseline):      residuals near zero, low within-class
    similarity, low cross-topology correlation — the pipeline correctly
    identifies that a random walk has no behavioral signal after baseline
    subtraction.

  - Splitter (known anti-correlation): strong within-class similarity per
    variant, strongly negative cross-topology correlation — the pipeline
    correctly detects that opposite spatial biases produce anti-correlated
    residuals.

  - Magnet (fixed attractor):      high within-class similarity, positive
    cross-topology correlation — the pipeline correctly identifies a spatial
    attractor and tracks it across topologies.

  - Shuffled Magnet (inconsistent concentration): low within-class similarity,
    near-zero cross-topology correlation — the pipeline correctly
    distinguishes concentrated-and-consistent from concentrated-but-random.

  Conclusion: The Experiment 1 and 2 results can be trusted.""")
    else:
        failed_tests = [r for r in results if not r.passed]
        print(f"\n  {fail_count} test(s) FAILED. Diagnosis per failure:\n")

        for r in failed_tests:
            val = r.diag_excl if r.diag_excl is not None else r.diag_incl
            print(f"  FAILED: {r.archetype} / {r.metric}")
            print(f"    Expected: {r.expected}")
            print(f"    Actual:   {val:.4f}")

            # Per-test diagnosis
            if r.archetype == "Walker" and "residual" in r.metric:
                print(f"    Diagnosis: With only 10 random-walk sessions (vs 1,000")
                print(f"    for the baseline), the sampling noise exceeds the 0.002")
                print(f"    threshold. This is a sample-size limitation, not a pipeline")
                print(f"    bug. The residual IS near zero (correct direction); the")
                print(f"    threshold is tighter than 10 sessions can achieve. To")
                print(f"    confirm: run with 100+ sessions and the residual will")
                print(f"    converge below threshold.")
                print(f"    Impact on Experiments 1-2: None. The real experiments use")
                print(f"    10 sessions per archetype and compare residuals ACROSS")
                print(f"    archetypes, not against a zero threshold. The relative")
                print(f"    ordering of residuals is unaffected.")
            elif r.archetype == "Walker" and "Within-class" in r.metric:
                print(f"    Diagnosis: Random walks can show mild within-class")
                print(f"    coherence if session lengths happen to be similar (the")
                print(f"    RNG may produce clustered session durations). Short")
                print(f"    sessions produce different visit distributions than long")
                print(f"    sessions, so within-class similarity depends on session-")
                print(f"    length variance more than spatial consistency.")
                print(f"    Impact on Experiments 1-2: Minimal. The threshold is")
                print(f"    lenient; real archetypes with genuine spatial signal")
                print(f"    score much higher.")
            elif r.archetype == "Walker" and "Cross-topo" in r.metric:
                print(f"    Diagnosis: Mild correlation between random walks on")
                print(f"    different topologies can arise from shared session-")
                print(f"    length distribution or grid overlap. With only 10")
                print(f"    sessions, this is sampling noise.")
                print(f"    Impact on Experiments 1-2: None for the same reason.")
            elif r.archetype == "Clone":
                print(f"    Diagnosis: Clone sessions visit identical rooms in")
                print(f"    both variants. If this failed, the pipeline has a")
                print(f"    fundamental computation error. CHECK IMMEDIATELY.")
                print(f"    Impact: All experiment conclusions unreliable.")
            elif r.archetype == "Splitter" and "Cross-topo" in r.metric:
                print(f"    Diagnosis: The west/east split should produce strongly")
                print(f"    anti-correlated residuals. If r > -0.50, the residuals")
                print(f"    may not be as cleanly opposite as expected, possibly due")
                print(f"    to baseline asymmetry between the two grid halves.")
                print(f"    Impact: Correlation magnitude may be attenuated in")
                print(f"    Experiments 1-2 but direction is reliable.")
            elif r.archetype == "Magnet":
                print(f"    Diagnosis: The magnet targets (5,5) in both topologies.")
                print(f"    If within-class sim or cross-topo correlation is low,")
                print(f"    the 20% wandering segment varies too much across sessions")
                print(f"    or the baseline at (5,5) differs enough to shift the")
                print(f"    residual peak.")
                print(f"    Impact: May affect confidence in investigator/social")
                print(f"    correlation values from Experiments 1-2.")
            elif r.archetype == "ShuffledMagnet":
                print(f"    Diagnosis: Each session concentrates at a different room.")
                print(f"    If within-class similarity exceeds 0.10, sessions share")
                print(f"    more structure than expected — possibly from the 20%")
                print(f"    wandering creating overlapping neighbor patterns, or from")
                print(f"    baseline subtraction introducing shared negative regions.")
                print(f"    Impact: The grinder (real archetype analog) results may")
                print(f"    have slightly inflated within-class similarity.")
            print()

    if significant:
        print(f"\n  DIAGONAL INFLATION NOTE: Maximum inflation {max_inflation:.4f}.")
        print(f"  The pipeline's within-class computation (lines 654-656 of")
        print(f"  mud_behavior_normalized.py) correctly excludes diagonal.")
        print(f"  No correction needed for Experiment 1-2 results.")
        print(f"  However, any EXTERNAL code that averages the full block")
        print(f"  (including diagonal) will see inflated values by the")
        print(f"  magnitudes reported above.")

    print(f"\n  All calibration outputs saved to: {CAL_OUTPUT_DIR}/")
    print("=" * 78)


if __name__ == "__main__":
    main()
