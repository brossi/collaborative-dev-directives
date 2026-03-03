#!/usr/bin/env python3
"""
MUD Behavioral Heatmap — Topology Normalization Extension

Extends the original heatmap system with random-walk baseline subtraction.
Imports grid builders, session generation, and helpers from mud_behavior_heatmaps.py.
Tests whether topology normalization recovers behavioral signal for archetypes
(explorer, grinder, lurker) that showed zero cross-topology correlation in raw data.

Outputs to output_heatmaps_normalized/.
"""

import os
import random
from datetime import timedelta

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
from matplotlib.lines import Line2D
from scipy.spatial.distance import cosine
import seaborn as sns

from mud_behavior_heatmaps import (
    SEED, GRID_ROWS, GRID_COLS, ARCHETYPES, NEXUS_POINTS,
    ARCHETYPE_COLORS, ROOM_TYPE_COLORS,
    assign_room_types, room_id, room_coords,
    build_open_grid, build_constrained_grid,
    generate_sessions, compute_visit_heatmap,
    plot_heatmap_on_ax,
    SESSION_MIN_MINUTES, SESSION_MAX_MINUTES,
    SESSIONS_PER_ARCHETYPE,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASELINE_SEED = 123
BASELINE_SESSIONS = 1000
NORM_OUTPUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "output_heatmaps_normalized"
)


def save_fig(fig, name):
    """Save figure to the normalized output directory."""
    path = os.path.join(NORM_OUTPUT_DIR, name)
    fig.savefig(path, dpi=150, bbox_inches="tight", facecolor="white")
    plt.close(fig)
    print(f"  Saved: {path}")


# ---------------------------------------------------------------------------
# Step 1: Random-Walk Baseline
# ---------------------------------------------------------------------------
def generate_random_walk_baseline(G, num_sessions, rng_seed):
    """Simulate pure random-walk sessions with no behavioral bias.

    Returns a 10x10 numpy array normalized so values sum to 1.0.
    Each session uses:
      - Uniform random neighbor selection at each step
      - Uniform dwell time (30-60s)
      - Session length drawn from same distribution as archetype sessions (15-120 min)
      - Random starting room
    """
    rng = random.Random(rng_seed)
    all_nodes = sorted(G.nodes())
    visit_grid = np.zeros((GRID_ROWS, GRID_COLS))

    for _ in range(num_sessions):
        session_minutes = rng.randint(SESSION_MIN_MINUTES, SESSION_MAX_MINUTES)
        remaining_seconds = session_minutes * 60
        current = rng.choice(all_nodes)

        while remaining_seconds > 0:
            r, c = room_coords(current)
            visit_grid[r][c] += 1

            dwell = rng.randint(30, 60)
            remaining_seconds -= dwell

            neighbors = list(G.successors(current))
            if not neighbors:
                break
            current = rng.choice(neighbors)

    total = visit_grid.sum()
    if total > 0:
        visit_grid /= total

    return visit_grid


# ---------------------------------------------------------------------------
# Step 2: Residual Heatmaps
# ---------------------------------------------------------------------------
def normalize_to_distribution(heatmap):
    """Normalize a heatmap so values sum to 1.0."""
    total = heatmap.sum()
    if total > 0:
        return heatmap / total
    return heatmap.copy()


def compute_residual(raw_heatmap, baseline):
    """Compute residual: normalize raw to sum-1.0, subtract baseline.

    Positive = archetype visits more than topology predicts.
    Negative = archetype visits less than topology predicts.
    """
    normed = normalize_to_distribution(raw_heatmap)
    return normed - baseline


# ---------------------------------------------------------------------------
# Step 3: Correlation & Proximity on Residuals
# ---------------------------------------------------------------------------
def compute_correlation(heatmap_a, heatmap_b, impassable):
    """Pearson correlation between two heatmaps, ignoring impassable rooms."""
    valid = np.ones((GRID_ROWS, GRID_COLS), dtype=bool)
    for r, c in impassable:
        valid[r][c] = False
    a = heatmap_a[valid].flatten()
    b = heatmap_b[valid].flatten()
    if a.std() > 0 and b.std() > 0:
        return np.corrcoef(a, b)[0, 1]
    return 0.0


def compute_nexus_proximity_density(heatmap, impassable):
    """Average heatmap value within manhattan distance 2 of nexus points."""
    total = 0.0
    count = 0
    for nr, nc in NEXUS_POINTS:
        for dr in range(-2, 3):
            for dc in range(-2, 3):
                if abs(dr) + abs(dc) <= 2:
                    rr, cc = nr + dr, nc + dc
                    if (0 <= rr < GRID_ROWS and 0 <= cc < GRID_COLS
                            and (rr, cc) not in impassable):
                        total += heatmap[rr][cc]
                        count += 1
    return total / max(count, 1)


def find_stable_rooms(residual_open, residual_const, impassable, room_types,
                      diff_thresh=0.1, density_thresh=0.15):
    """Find rooms where |residual diff| < threshold and density > threshold."""
    diff = residual_const - residual_open
    stable = []
    for r in range(GRID_ROWS):
        for c in range(GRID_COLS):
            if (r, c) in impassable:
                continue
            if abs(diff[r][c]) < diff_thresh and residual_open[r][c] > density_thresh:
                stable.append((r, c, residual_open[r][c], room_types[r][c]))
    return sorted(stable, key=lambda x: -x[2])


# ---------------------------------------------------------------------------
# Step 5: Separability Matrix
# ---------------------------------------------------------------------------
def compute_per_session_residual_heatmaps(sessions, baseline):
    """Compute a residual heatmap per individual session."""
    per_session = []
    for s in sessions:
        grid = np.zeros((GRID_ROWS, GRID_COLS))
        for t in s["transitions"]:
            r, c = room_coords(t["room_id"])
            grid[r][c] += 1
        normed = normalize_to_distribution(grid)
        residual = normed - baseline
        per_session.append({
            "archetype": s["archetype"],
            "residual": residual,
        })
    return per_session


def compute_separability_matrix(per_session_residuals):
    """Compute 50x50 pairwise cosine similarity matrix.

    Sessions are ordered by archetype so diagonal blocks
    correspond to within-archetype similarity.
    """
    # Sort by archetype order
    arch_order = {a: i for i, a in enumerate(ARCHETYPES)}
    items = sorted(per_session_residuals, key=lambda x: arch_order[x["archetype"]])

    n = len(items)
    sim_matrix = np.zeros((n, n))
    vectors = [it["residual"].flatten() for it in items]

    for i in range(n):
        for j in range(n):
            if i == j:
                sim_matrix[i][j] = 1.0
            elif j > i:
                # Cosine similarity = 1 - cosine distance
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


# ---------------------------------------------------------------------------
# Visualization Helpers
# ---------------------------------------------------------------------------
def plot_diverging_heatmap(ax, data, title, impassable=None, vabs=None,
                           show_nexus=True):
    """Plot a residual heatmap with diverging colormap (blue/white/red)."""
    display = data.copy().astype(float)
    if impassable:
        for r, c in impassable:
            display[r][c] = np.nan

    mask = np.isnan(display)
    if vabs is None:
        valid_vals = display[~mask]
        if len(valid_vals) > 0:
            vabs = max(abs(valid_vals.min()), abs(valid_vals.max()), 1e-6)
        else:
            vabs = 1e-6

    sns.heatmap(display, ax=ax, cmap="RdBu_r", mask=mask,
                vmin=-vabs, vmax=vabs, center=0,
                square=True, cbar=True, cbar_kws={"shrink": 0.6},
                linewidths=0.3, linecolor="#eeeeee",
                xticklabels=range(GRID_COLS),
                yticklabels=range(GRID_ROWS))

    if impassable:
        for r, c in impassable:
            ax.add_patch(plt.Rectangle((c, r), 1, 1, fill=True,
                         facecolor="#1a5276", alpha=0.6))

    if show_nexus:
        for r, c in NEXUS_POINTS:
            ax.plot(c + 0.5, r + 0.5, marker="*", markersize=12,
                    color="lime", markeredgecolor="black", markeredgewidth=0.5,
                    zorder=10)

    ax.set_title(title, fontsize=9, fontweight="bold")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    os.makedirs(NORM_OUTPUT_DIR, exist_ok=True)
    print("=" * 70)
    print("MUD Behavioral Heatmap — Topology Normalization Experiment")
    print("=" * 70)

    room_types = assign_room_types()

    # Build grids (identical to original)
    print("\n[1] Building grid variants...")
    G_open, sc_open = build_open_grid()
    G_const, sc_const, impassable, oneway = build_constrained_grid()
    print(f"  Open:        {G_open.number_of_nodes()} rooms, "
          f"{G_open.number_of_edges()} edges")
    print(f"  Constrained: {G_const.number_of_nodes()} rooms, "
          f"{G_const.number_of_edges()} edges, "
          f"{len(impassable)} impassable")

    # Generate archetype sessions (same seed as original)
    print("\n[2] Generating archetype sessions (seed={})...".format(SEED))
    sessions_open = generate_sessions(G_open, room_types, "open", SEED)
    sessions_const = generate_sessions(G_const, room_types, "constrained", SEED)
    print(f"  {len(sessions_open)} open + {len(sessions_const)} constrained sessions")

    # ===================================================================
    # STEP 1: Random-Walk Baselines
    # ===================================================================
    print(f"\n[3] Generating random-walk baselines "
          f"({BASELINE_SESSIONS} sessions, seed={BASELINE_SEED})...")
    baseline_open = generate_random_walk_baseline(
        G_open, BASELINE_SESSIONS, BASELINE_SEED)
    baseline_const = generate_random_walk_baseline(
        G_const, BASELINE_SESSIONS, BASELINE_SEED)
    print(f"  Open baseline:        sum={baseline_open.sum():.4f}, "
          f"max={baseline_open.max():.4f}, min={baseline_open.min():.6f}")
    print(f"  Constrained baseline: sum={baseline_const.sum():.4f}, "
          f"max={baseline_const.max():.4f}, min={baseline_const.min():.6f}")

    # Verify baseline properties
    open_nonzero = np.count_nonzero(baseline_open)
    const_nonzero = np.count_nonzero(baseline_const)
    print(f"  Open rooms with traffic:        {open_nonzero}/100")
    print(f"  Constrained rooms with traffic: {const_nonzero}/"
          f"{100 - len(impassable)}")

    # ===================================================================
    # STEP 2: Compute Residual Heatmaps
    # ===================================================================
    print("\n[4] Computing residual heatmaps...")
    raw_heatmaps = {}
    residual_heatmaps = {}

    for arch in ARCHETYPES:
        raw_o = compute_visit_heatmap(sessions_open, arch)
        raw_c = compute_visit_heatmap(sessions_const, arch)
        raw_heatmaps[(arch, "open")] = raw_o
        raw_heatmaps[(arch, "constrained")] = raw_c
        residual_heatmaps[(arch, "open")] = compute_residual(raw_o, baseline_open)
        residual_heatmaps[(arch, "constrained")] = compute_residual(
            raw_c, baseline_const)

    for arch in ARCHETYPES:
        res_o = residual_heatmaps[(arch, "open")]
        res_c = residual_heatmaps[(arch, "constrained")]
        print(f"  {arch:>13s}: open  residual range [{res_o.min():.4f}, "
              f"{res_o.max():.4f}]")
        print(f"  {' ':>13s}  const residual range [{res_c.min():.4f}, "
              f"{res_c.max():.4f}]")

    # ===================================================================
    # STEP 3: Re-run Correlation & Proximity Analysis on Residuals
    # ===================================================================
    print("\n[5] Correlation analysis: raw vs. residual...")
    print("-" * 70)
    print(f"  {'Archetype':>13s}  {'Raw r':>8s}  {'Residual r':>10s}  "
          f"{'Delta':>8s}  {'Improvement':>12s}")
    print("-" * 70)

    raw_correlations = {}
    residual_correlations = {}

    for arch in ARCHETYPES:
        # Raw correlation (reproduce original methodology: max-normalize)
        raw_o = raw_heatmaps[(arch, "open")]
        raw_c = raw_heatmaps[(arch, "constrained")]
        if raw_o.max() > 0:
            raw_o_n = raw_o / raw_o.max()
        else:
            raw_o_n = raw_o
        if raw_c.max() > 0:
            raw_c_n = raw_c / raw_c.max()
        else:
            raw_c_n = raw_c
        raw_corr = compute_correlation(raw_o_n, raw_c_n, impassable)
        raw_correlations[arch] = raw_corr

        # Residual correlation
        res_o = residual_heatmaps[(arch, "open")]
        res_c = residual_heatmaps[(arch, "constrained")]
        res_corr = compute_correlation(res_o, res_c, impassable)
        residual_correlations[arch] = res_corr

        delta = res_corr - raw_corr
        improved = "YES" if delta > 0.05 else ("marginal" if delta > 0 else "no")
        print(f"  {arch:>13s}  {raw_corr:>8.3f}  {res_corr:>10.3f}  "
              f"{delta:>+8.3f}  {improved:>12s}")

    print("-" * 70)

    # Nexus proximity on residuals
    print("\n[6] Nexus proximity density on residuals...")
    print(f"  {'Archetype':>13s}  {'Open':>8s}  {'Const':>8s}  {'Delta':>8s}")
    print("-" * 50)
    for arch in ARCHETYPES:
        prox_o = compute_nexus_proximity_density(
            residual_heatmaps[(arch, "open")], impassable)
        prox_c = compute_nexus_proximity_density(
            residual_heatmaps[(arch, "constrained")], impassable)
        delta = prox_c - prox_o
        print(f"  {arch:>13s}  {prox_o:>8.4f}  {prox_c:>8.4f}  {delta:>+8.4f}")
    print("-" * 50)

    # Archetype-stable rooms on residuals
    print("\n[7] Archetype-stable rooms on residuals (investigator)...")
    stable_rooms = find_stable_rooms(
        residual_heatmaps[("investigator", "open")],
        residual_heatmaps[("investigator", "constrained")],
        impassable, room_types,
        diff_thresh=0.002, density_thresh=0.005)
    print(f"  Found {len(stable_rooms)} stable rooms "
          f"(|diff| < 0.002, density > 0.005):")
    for r, c, density, rtype in stable_rooms[:15]:
        print(f"    ({r},{c}) {rtype:>10s}: residual density {density:.4f}")

    # Compare to broader set across archetypes
    print("\n  Stable rooms by archetype:")
    for arch in ARCHETYPES:
        stable = find_stable_rooms(
            residual_heatmaps[(arch, "open")],
            residual_heatmaps[(arch, "constrained")],
            impassable, room_types,
            diff_thresh=0.002, density_thresh=0.003)
        print(f"    {arch:>13s}: {len(stable)} stable rooms")

    # ===================================================================
    # STEP 4: Visualizations
    # ===================================================================
    print("\n[8] Generating visualizations...")

    # --- 4.1: Random-Walk Baseline Heatmaps ---
    print("  [8.1] Random-walk baseline heatmaps...")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 7))
    plot_heatmap_on_ax(ax1, baseline_open * 1000,
                       "Random-Walk Baseline — Open\n(values x1000)",
                       cmap="YlOrRd")
    plot_heatmap_on_ax(ax2, baseline_const * 1000,
                       "Random-Walk Baseline — Constrained\n(values x1000)",
                       cmap="YlOrRd", impassable=impassable)
    fig.suptitle("Topology Baseline: Expected Visit Frequency (1000 Random Walks)",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.93])
    save_fig(fig, "01_random_walk_baselines.png")

    # --- 4.2: Raw vs Residual Per-Archetype (per variant) ---
    print("  [8.2] Raw vs. residual heatmaps per archetype...")
    for variant, imp in [("open", None), ("constrained", impassable)]:
        fig, axes = plt.subplots(2, 5, figsize=(26, 10))

        for i, arch in enumerate(ARCHETYPES):
            raw = raw_heatmaps[(arch, variant)]
            res = residual_heatmaps[(arch, variant)]

            # Top row: raw (sum-normalized for comparable scale)
            raw_normed = normalize_to_distribution(raw)
            plot_heatmap_on_ax(axes[0, i], raw_normed * 1000,
                               f"{arch.capitalize()} Raw",
                               cmap="YlOrRd", impassable=imp)

            # Bottom row: residual (diverging)
            plot_diverging_heatmap(axes[1, i], res * 1000,
                                  f"{arch.capitalize()} Residual",
                                  impassable=imp)

        fig.suptitle(f"Raw vs. Residual Heatmaps — {variant.capitalize()}\n"
                     f"(Top: raw distribution x1000, "
                     f"Bottom: residual x1000, red=above baseline, "
                     f"blue=below)",
                     fontsize=13, fontweight="bold")
        plt.tight_layout(rect=[0, 0, 1, 0.91])
        save_fig(fig, f"02_raw_vs_residual_{variant}.png")

    # --- 4.3: Residual Composite Overlay ---
    print("  [8.3] Residual composite overlay...")
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(18, 8))

    arch_rgb = {
        "explorer": np.array([0.12, 0.47, 0.71]),
        "social": np.array([1.0, 0.50, 0.05]),
        "investigator": np.array([0.17, 0.63, 0.17]),
        "grinder": np.array([0.84, 0.15, 0.16]),
        "lurker": np.array([0.58, 0.40, 0.74]),
    }

    for ax, variant, label, imp in [
        (ax1, "open", "Open", None),
        (ax2, "constrained", "Constrained", impassable)
    ]:
        composite = np.zeros((GRID_ROWS, GRID_COLS, 3))

        for arch in ARCHETYPES:
            res = residual_heatmaps[(arch, variant)]
            # Use only positive residuals for overlay (above-baseline signal)
            pos = np.clip(res, 0, None)
            if pos.max() > 0:
                pos_norm = pos / pos.max()
            else:
                pos_norm = pos
            for r in range(GRID_ROWS):
                for c in range(GRID_COLS):
                    composite[r, c] += pos_norm[r, c] * arch_rgb[arch]

        if composite.max() > 0:
            composite = composite / composite.max()

        if imp:
            for r, c in imp:
                composite[r, c] = [0.1, 0.15, 0.3]

        ax.imshow(composite, interpolation="nearest", aspect="equal")
        for r, c in NEXUS_POINTS:
            ax.plot(c, r, marker="*", markersize=15, color="white",
                    markeredgecolor="black", markeredgewidth=1, zorder=10)
        ax.set_title(f"Residual Composite — {label}", fontsize=11,
                     fontweight="bold")
        ax.set_xticks(range(GRID_COLS))
        ax.set_yticks(range(GRID_ROWS))
        ax.grid(True, alpha=0.2, color="white")

    legend_patches = [mpatches.Patch(color=ARCHETYPE_COLORS[a],
                      label=a.capitalize()) for a in ARCHETYPES]
    legend_patches.append(Line2D([0], [0], marker="*", color="w",
                                 markerfacecolor="white", markeredgecolor="black",
                                 markersize=12, label="Nexus"))
    fig.legend(handles=legend_patches, loc="lower center", ncol=6, fontsize=9,
               bbox_to_anchor=(0.5, -0.02))
    fig.suptitle("Composite Archetype Overlay (Residual — Above-Baseline Only)",
                 fontsize=14, fontweight="bold")
    plt.tight_layout(rect=[0, 0.03, 1, 0.95])
    save_fig(fig, "03_residual_composite_overlay.png")

    # --- 4.4: Residual Difference Maps ---
    print("  [8.4] Residual difference maps...")
    fig, axes = plt.subplots(2, 5, figsize=(26, 10))

    for i, arch in enumerate(ARCHETYPES):
        # Original raw difference (top row)
        raw_o = raw_heatmaps[(arch, "open")]
        raw_c = raw_heatmaps[(arch, "constrained")]
        if raw_o.max() > 0:
            raw_o_n = raw_o / raw_o.max()
        else:
            raw_o_n = raw_o
        if raw_c.max() > 0:
            raw_c_n = raw_c / raw_c.max()
        else:
            raw_c_n = raw_c
        raw_diff = raw_c_n - raw_o_n

        vabs_raw = max(abs(raw_diff.min()), abs(raw_diff.max()), 0.01)
        plot_diverging_heatmap(axes[0, i], raw_diff,
                               f"{arch.capitalize()} Raw Diff",
                               impassable=impassable, vabs=vabs_raw)

        # Residual difference (bottom row)
        res_o = residual_heatmaps[(arch, "open")]
        res_c = residual_heatmaps[(arch, "constrained")]
        res_diff = res_c - res_o

        vabs_res = max(abs(res_diff.min()), abs(res_diff.max()), 1e-5)
        plot_diverging_heatmap(axes[1, i], res_diff * 1000,
                               f"{arch.capitalize()} Residual Diff (x1000)",
                               impassable=impassable)

    fig.suptitle("Difference Maps: Raw (top) vs. Residual (bottom)\n"
                 "Red = more in constrained, Blue = less | "
                 "Less extreme residual diffs = topology factored out",
                 fontsize=13, fontweight="bold")
    plt.tight_layout(rect=[0, 0, 1, 0.91])
    save_fig(fig, "04_residual_difference_maps.png")

    # --- 4.5: Correlation Improvement Bar Chart ---
    print("  [8.5] Correlation improvement bar chart...")
    fig, ax = plt.subplots(figsize=(12, 7))

    x = np.arange(len(ARCHETYPES))
    width = 0.35
    raw_vals = [raw_correlations[a] for a in ARCHETYPES]
    res_vals = [residual_correlations[a] for a in ARCHETYPES]

    bars1 = ax.bar(x - width / 2, raw_vals, width, label="Raw Correlation",
                   color="#95a5a6", edgecolor="black", linewidth=0.5)
    bars2 = ax.bar(x + width / 2, res_vals, width, label="Residual Correlation",
                   color="#2ecc71", edgecolor="black", linewidth=0.5)

    # Add value labels on bars
    for bar in bars1:
        h = bar.get_height()
        sign = "" if h >= 0 else ""
        ax.text(bar.get_x() + bar.get_width() / 2, h + 0.02 * (1 if h >= 0 else -1),
                f"{h:.3f}", ha="center", va="bottom" if h >= 0 else "top",
                fontsize=9, fontweight="bold", color="#555555")
    for bar in bars2:
        h = bar.get_height()
        ax.text(bar.get_x() + bar.get_width() / 2, h + 0.02 * (1 if h >= 0 else -1),
                f"{h:.3f}", ha="center", va="bottom" if h >= 0 else "top",
                fontsize=9, fontweight="bold", color="#1a5276")

    ax.set_xticks(x)
    ax.set_xticklabels([a.capitalize() for a in ARCHETYPES], fontsize=11)
    ax.set_ylabel("Pearson Correlation (Open vs. Constrained)", fontsize=11)
    ax.set_title("Cross-Topology Correlation: Raw vs. Topology-Normalized",
                 fontsize=14, fontweight="bold")
    ax.legend(fontsize=11, loc="upper left")
    ax.axhline(y=0, color="black", linewidth=0.5)
    ax.axhline(y=0.4, color="gray", linewidth=0.5, linestyle="--", alpha=0.5)
    ax.axhline(y=0.7, color="gray", linewidth=0.5, linestyle="--", alpha=0.5)
    ax.text(4.6, 0.41, "moderate", fontsize=8, color="gray")
    ax.text(4.6, 0.71, "high", fontsize=8, color="gray")
    ax.set_ylim(min(min(raw_vals), min(res_vals)) - 0.15,
                max(max(raw_vals), max(res_vals)) + 0.15)
    ax.grid(axis="y", alpha=0.3)

    # Add delta annotations
    for i, arch in enumerate(ARCHETYPES):
        delta = res_vals[i] - raw_vals[i]
        color = "#27ae60" if delta > 0.05 else ("#e67e22" if delta > 0 else "#c0392b")
        mid_y = (raw_vals[i] + res_vals[i]) / 2
        ax.annotate(f"{delta:+.3f}",
                    xy=(i, mid_y), fontsize=8, fontweight="bold",
                    color=color, ha="center",
                    bbox=dict(boxstyle="round,pad=0.2", facecolor="white",
                              edgecolor=color, alpha=0.9))

    plt.tight_layout()
    save_fig(fig, "05_correlation_improvement.png")

    # ===================================================================
    # STEP 5: Separability Matrix
    # ===================================================================
    print("\n[9] Computing archetype separability matrices...")

    for variant, sessions, baseline, imp, label in [
        ("open", sessions_open, baseline_open, set(), "Open"),
        ("constrained", sessions_const, baseline_const, impassable, "Constrained"),
    ]:
        per_session = compute_per_session_residual_heatmaps(sessions, baseline)
        sim_matrix, labels = compute_separability_matrix(per_session)

        fig, ax = plt.subplots(figsize=(12, 10))

        sns.heatmap(sim_matrix, ax=ax, cmap="RdYlBu_r",
                    vmin=-0.5, vmax=1.0, center=0.25,
                    square=True, cbar=True,
                    cbar_kws={"shrink": 0.7, "label": "Cosine Similarity"},
                    linewidths=0, xticklabels=False, yticklabels=False)

        # Draw archetype block boundaries and labels
        sessions_per = SESSIONS_PER_ARCHETYPE
        for idx, arch in enumerate(ARCHETYPES):
            start = idx * sessions_per
            end = start + sessions_per
            rect = plt.Rectangle((start, start), sessions_per, sessions_per,
                                 fill=False, edgecolor="black", linewidth=2)
            ax.add_patch(rect)
            ax.text(start + sessions_per / 2, start + sessions_per / 2,
                    arch.capitalize(), ha="center", va="center",
                    fontsize=9, fontweight="bold",
                    bbox=dict(boxstyle="round", facecolor="white", alpha=0.8))

        # X/Y axis archetype labels
        for idx, arch in enumerate(ARCHETYPES):
            mid = idx * sessions_per + sessions_per / 2
            ax.text(mid, len(labels) + 1.5, arch[:3].upper(),
                    ha="center", va="top", fontsize=9, fontweight="bold")
            ax.text(-1.5, mid, arch[:3].upper(),
                    ha="right", va="center", fontsize=9, fontweight="bold")

        ax.set_title(f"Session Separability Matrix — {label}\n"
                     f"(50x50 pairwise cosine similarity on residual heatmaps)",
                     fontsize=13, fontweight="bold")
        plt.tight_layout()
        save_fig(fig, f"06_separability_matrix_{variant}.png")

        # Compute within-archetype vs between-archetype similarity
        within_sims = []
        between_sims = []
        for i in range(len(labels)):
            for j in range(i + 1, len(labels)):
                if labels[i] == labels[j]:
                    within_sims.append(sim_matrix[i][j])
                else:
                    between_sims.append(sim_matrix[i][j])

        within_mean = np.mean(within_sims) if within_sims else 0
        between_mean = np.mean(between_sims) if between_sims else 0
        separation_gap = within_mean - between_mean
        print(f"  {label}:")
        print(f"    Within-archetype mean similarity:  {within_mean:.3f}")
        print(f"    Between-archetype mean similarity: {between_mean:.3f}")
        print(f"    Separation gap:                    {separation_gap:.3f}")

        # Per-archetype within-class similarity
        for arch in ARCHETYPES:
            arch_sims = []
            arch_indices = [i for i, l in enumerate(labels) if l == arch]
            for i in range(len(arch_indices)):
                for j in range(i + 1, len(arch_indices)):
                    arch_sims.append(
                        sim_matrix[arch_indices[i]][arch_indices[j]])
            mean_s = np.mean(arch_sims) if arch_sims else 0
            print(f"      {arch:>13s} within-class: {mean_s:.3f}")

    # ===================================================================
    # FINAL SUMMARY
    # ===================================================================
    print("\n" + "=" * 70)
    print("SUMMARY: TOPOLOGY NORMALIZATION RESULTS")
    print("=" * 70)

    print("\n  Cross-topology correlation comparison:")
    print(f"  {'Archetype':>13s}  {'Raw':>8s}  {'Residual':>8s}  "
          f"{'Delta':>8s}  {'Verdict':>20s}")
    print("  " + "-" * 65)

    for arch in ARCHETYPES:
        raw_r = raw_correlations[arch]
        res_r = residual_correlations[arch]
        delta = res_r - raw_r

        if res_r > 0.7:
            verdict = "STRONG signal"
        elif res_r > 0.4:
            verdict = "MODERATE signal"
        elif res_r > 0.1:
            verdict = "WEAK signal"
        else:
            verdict = "NO signal"

        if delta > 0.2:
            verdict += " (RECOVERED)"
        elif delta > 0.05:
            verdict += " (improved)"

        print(f"  {arch:>13s}  {raw_r:>8.3f}  {res_r:>8.3f}  "
              f"{delta:>+8.3f}  {verdict:>20s}")

    print("  " + "-" * 65)

    # Interpretation
    recovered = [a for a in ARCHETYPES
                 if residual_correlations[a] - raw_correlations[a] > 0.15]
    maintained = [a for a in ARCHETYPES
                  if raw_correlations[a] > 0.4 and residual_correlations[a] > 0.4]
    failed = [a for a in ARCHETYPES
              if residual_correlations[a] < 0.15]

    print(f"\n  Signal recovered by normalization: {recovered or 'none'}")
    print(f"  Signal maintained after normalization: {maintained or 'none'}")
    print(f"  No signal even after normalization: {failed or 'none'}")

    if failed:
        print(f"\n  Archetypes with no spatial signal ({', '.join(failed)}) "
              f"require")
        print(f"  multi-feature classification (command profile, temporal pattern)")
        print(f"  rather than heatmap-only approaches.")

    if recovered:
        print(f"\n  Normalization WORKS for {', '.join(recovered)} — the Chaos")
        print(f"  Monkey can use: raw heatmap -> subtract baseline -> classify")
        print(f"  as a single pipeline for these archetypes.")

    print(f"\n  All outputs saved to: {NORM_OUTPUT_DIR}/")
    print("=" * 70)


if __name__ == "__main__":
    main()
