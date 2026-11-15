from pathlib import Path
import tempfile
import unittest
import numpy as np
from hand_pose import load_hand_mean, absolute_hand_pose, prepare_motion


class HandPoseTests(unittest.TestCase):
    def test_experimental_profile_preserves_source_and_expression_without_adding_mean(self):
        from scipy.spatial.transform import Rotation
        source = np.linspace(-.9, .9, 266, dtype=np.float32).reshape(2, 133)
        original = source.copy()
        result = prepare_motion(source, 'experimental-inverse', np.ones(90, dtype=np.float32))
        np.testing.assert_array_equal(source, original)
        np.testing.assert_array_equal(result[:, 30:75], source[:, 30:75])
        np.testing.assert_array_equal(result[:, 120:], source[:, 120:])
        rotation = lambda block: Rotation.from_rotvec(block.reshape(-1, 3)).as_matrix()
        np.testing.assert_allclose(rotation(result[:, :30]), rotation(source[:, :30]).transpose(0, 2, 1), atol=1e-6)
        mirror = np.diag([-1., 1., 1.])
        np.testing.assert_allclose(rotation(result[:, 75:120]), mirror @ rotation(source[:, 75:120]) @ mirror, atol=1e-6)

    def test_profile_validation_and_legacy_rollback(self):
        source = np.zeros((2, 133), dtype=np.float32)
        with self.assertRaisesRegex(ValueError, 'Unknown'):
            prepare_motion(source, 'other')
        with self.assertRaisesRegex(ValueError, 'required'):
            prepare_motion(source, 'smplx-offsets')
        for bad in (np.zeros((2, 132)), np.full((2, 133), np.nan), np.full((2, 133), 101)):
            with self.assertRaisesRegex(ValueError, 'Invalid motion'):
                prepare_motion(bad, 'experimental-inverse')
        mean = np.linspace(-.5, .5, 90, dtype=np.float32)
        np.testing.assert_array_equal(prepare_motion(source, 'smplx-offsets', mean), absolute_hand_pose(source, mean))

    def test_missing_or_malformed_calibration_fails_instead_of_substituting_zero(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'model.npz'
            with self.assertRaises(FileNotFoundError):
                load_hand_mean(path)
            for value in (np.zeros(44), np.full(45, np.nan), np.full(45, 100), np.array([{}] * 45, dtype=object)):
                np.savez(path, hands_meanl=value, hands_meanr=np.zeros(45))
                with self.assertRaises(ValueError):
                    load_hand_mean(path)

    def test_mean_is_added_once_to_all_hand_axes_without_mutating_source(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'model.npz'
            left = np.linspace(-.5, .5, 45, dtype=np.float32)
            right = -left
            np.savez(path, hands_meanl=left, hands_meanr=right)
            mean = load_hand_mean(path)
        source = np.linspace(-1, 1, 266, dtype=np.float32).reshape(2, 133)
        original = source.copy()
        result = absolute_hand_pose(source, mean)
        np.testing.assert_array_equal(source, original)
        np.testing.assert_array_equal(result[:, :30], source[:, :30])
        np.testing.assert_array_equal(result[:, 120:], source[:, 120:])
        np.testing.assert_array_equal(result[:, 30:75], source[:, 30:75] + left)
        np.testing.assert_array_equal(result[:, 75:120], source[:, 75:120] + right)


if __name__ == '__main__':
    unittest.main()
