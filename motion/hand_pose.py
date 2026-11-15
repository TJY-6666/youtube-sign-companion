"""Prepare viewer rotations; source-convention experiments are explicitly opt-in."""
from pathlib import Path
import numpy as np

POSE_PROFILES = ('smplx-offsets', 'experimental-inverse')


def load_hand_mean(filename):
    path = Path(filename)
    if not path.is_file():
        raise FileNotFoundError('SMPL-X hand calibration is missing. Place SMPLX_NEUTRAL.npz in models/smplx or set MOTION_SMPLX_MODEL, then restart.')
    if path.stat().st_size > 512 * 1024**2:
        raise ValueError('SMPL-X hand calibration file exceeds the size limit.')
    with np.load(path, allow_pickle=False) as archive:
        parts = [np.asarray(archive[key], dtype=np.float32) for key in ('hands_meanl', 'hands_meanr')]
    if any(part.shape != (45,) or not np.isfinite(part).all() or np.abs(part).max() > 4 * np.pi for part in parts):
        raise ValueError('Invalid SMPL-X hand calibration arrays.')
    return np.concatenate(parts)


def absolute_hand_pose(motion, mean):
    if motion.ndim != 2 or motion.shape[1] != 133 or mean.shape != (90,):
        raise ValueError('Invalid motion or hand calibration shape.')
    result = motion.copy()
    # SMPL-X adds the mean in axis-angle space before converting to rotations.
    result[:, 30:120] += mean
    if not np.isfinite(result).all() or np.abs(result).max() > 100:
        raise ValueError('Invalid calibrated motion.')
    return result


def prepare_motion(motion, profile, mean=None):
    if profile not in POSE_PROFILES:
        raise ValueError('Unknown motion pose profile.')
    if profile == 'smplx-offsets':
        if mean is None:
            raise ValueError('SMPL-X hand calibration is required for the offsets profile.')
        return absolute_hand_pose(motion, mean)
    if motion.ndim != 2 or motion.shape[1] != 133 or not 1 <= len(motion) <= 400 or not np.isfinite(motion).all() or np.abs(motion).max() > 100:
        raise ValueError('Invalid motion for the experimental pose correction.')
    result = motion.copy()
    # shortcut: source convention is inferred, replace after paired source-frame validation.
    result[:, :30] *= -1
    result[:, 75:120].reshape(-1, 15, 3)[:, :, 1:] *= -1
    return result
