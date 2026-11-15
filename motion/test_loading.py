from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import torch
from safetensors.torch import save_file
from loading import copy_checkpoint


class LoadingTests(unittest.TestCase):
    def test_streamed_copy_matches_known_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            model = torch.nn.Linear(3, 2).to(dtype=torch.bfloat16)
            state = {'weight': torch.arange(6, dtype=torch.float32).reshape(2, 3), 'bias': torch.tensor([2., 3.])}
            save_file(state, str(Path(directory) / 'model.safetensors'))
            with patch('loading.COPY_CHUNK_BYTES', 16):
                self.assertEqual(copy_checkpoint(model, directory), 2)
            for name, value in model.state_dict().items():
                torch.testing.assert_close(value.float(), state[name])

    def test_wrong_shapes_and_missing_tensors_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = str(Path(directory) / 'model.safetensors')
            model = torch.nn.Linear(3, 2)
            save_file({'weight': torch.ones(2, 4)}, filename)
            with self.assertRaisesRegex(ValueError, 'shape mismatch'):
                copy_checkpoint(model, directory)
            save_file({'weight': torch.ones(2, 3)}, filename)
            with self.assertRaisesRegex(ValueError, 'missing'):
                copy_checkpoint(model, directory)

    def test_truncated_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'model.safetensors'
            save_file({'weight': torch.ones(2, 3), 'bias': torch.zeros(2)}, str(filename))
            filename.write_bytes(filename.read_bytes()[:-1])
            with self.assertRaisesRegex(ValueError, 'truncated'):
                copy_checkpoint(torch.nn.Linear(3, 2), directory)

    def test_tied_parameter_conflicts_are_rejected(self):
        class Tied(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.one = torch.nn.Parameter(torch.zeros(9))
                self.two = self.one
        with tempfile.TemporaryDirectory() as directory:
            conflicting = torch.ones(9); conflicting[-1] = 0
            save_file({'one': torch.ones(9), 'two': conflicting}, str(Path(directory) / 'model.safetensors'))
            with patch('loading.COPY_CHUNK_BYTES', 16), self.assertRaisesRegex(ValueError, 'tied parameter'):
                copy_checkpoint(Tied(), directory)


if __name__ == '__main__':
    unittest.main()
