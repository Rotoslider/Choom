"""
Viseme and expression morph target definitions.

Maps FLAME expression coefficients to viseme/expression morph targets.
Each target is a dict of FLAME expression indices → weights that define
the vertex displacement from neutral.

FLAME has 50 expression coefficients (from FLAME's expression PCA basis).
Key coefficients:
  0: jaw open
  1-3: lip movements (pucker, stretch, etc.)
  4-9: various lip shapes
  10-14: cheek/nose
  15-49: higher-order expressions
"""

import numpy as np


# 15 Oculus-standard visemes mapped to FLAME expression coefficients
# Each entry: { expression_index: weight }
VISEME_DEFINITIONS = {
    # Silence - neutral mouth
    "viseme_sil": {0: 0.0},

    # PP - lips pressed (p, b, m)
    "viseme_PP": {0: 0.02, 1: 0.6, 4: 0.3},

    # FF - lower lip tucked (f, v)
    "viseme_FF": {0: 0.05, 2: 0.5, 5: 0.3},

    # TH - tongue between teeth approximation (th)
    "viseme_TH": {0: 0.15, 3: 0.2, 6: 0.15},

    # DD - tongue behind upper teeth (t, d, n)
    "viseme_DD": {0: 0.2, 1: 0.1, 7: 0.2},

    # kk - mid jaw open (k, g)
    "viseme_kk": {0: 0.35, 8: 0.15},

    # CH - lips rounded forward (ch, j, sh)
    "viseme_CH": {0: 0.2, 1: 0.4, 3: 0.3},

    # SS - lips slightly parted (s, z)
    "viseme_SS": {0: 0.1, 2: 0.3, 9: 0.2},

    # nn - slight jaw open (n, l)
    "viseme_nn": {0: 0.18, 1: 0.05, 7: 0.1},

    # RR - lips rounded (r)
    "viseme_RR": {0: 0.15, 1: 0.35, 3: 0.25},

    # aa - jaw wide open (a as in father)
    "viseme_aa": {0: 0.7, 4: 0.1, 10: 0.1},

    # E - lips spread (e as in bed)
    "viseme_E": {0: 0.35, 2: 0.4, 5: 0.15},

    # I - lips narrow spread (i as in see)
    "viseme_I": {0: 0.2, 2: 0.55, 9: 0.1},

    # O - lips rounded open (o as in go)
    "viseme_O": {0: 0.45, 1: 0.5, 3: 0.2},

    # U - lips tight round (u as in food)
    "viseme_U": {0: 0.25, 1: 0.6, 3: 0.35},
}

# Expression morph targets
EXPRESSION_DEFINITIONS = {
    # Smile
    "expr_smile": {12: 0.8, 13: 0.3, 14: 0.2, 2: 0.15},

    # Frown
    "expr_frown": {15: 0.6, 16: 0.4, 0: 0.05},

    # Surprise - eyebrows up, mouth slightly open
    "expr_surprise": {17: 0.7, 18: 0.5, 0: 0.3},

    # Anger - brows furrowed
    "expr_anger": {19: 0.6, 20: 0.4, 15: 0.3},

    # Blink - eyes closed
    "expr_blink": {21: 0.9, 22: 0.9},
}

# All morph target names in order (used for GLB export)
ALL_MORPH_TARGETS = list(VISEME_DEFINITIONS.keys()) + list(EXPRESSION_DEFINITIONS.keys())


def compute_morph_target_displacements(
    expression_basis: np.ndarray,
    neutral_vertices: np.ndarray,
) -> dict[str, np.ndarray]:
    """
    Compute vertex displacements for each morph target from FLAME expression basis.

    Args:
        expression_basis: (50, N, 3) array of expression basis vectors
        neutral_vertices: (N, 3) neutral vertex positions

    Returns:
        dict mapping morph target name → (N, 3) displacement array
    """
    num_basis = expression_basis.shape[0]
    displacements = {}

    all_defs = {**VISEME_DEFINITIONS, **EXPRESSION_DEFINITIONS}

    for name, coeff_weights in all_defs.items():
        displacement = np.zeros_like(neutral_vertices)
        for idx, weight in coeff_weights.items():
            if idx < num_basis:
                displacement += weight * expression_basis[idx]
        displacements[name] = displacement

    return displacements
