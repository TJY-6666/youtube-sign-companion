import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('gpu_probe', Path(__file__).with_name('check-gpu.py'))
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class FakeTensor:
    def __init__(self, torch, dtype): self.torch, self.dtype = torch, dtype
    def __matmul__(self, other):
        if self.dtype == 'bf16' and self.torch.half_error: raise RuntimeError('unsupported')
        return self
    def to(self, dtype): return FakeTensor(self.torch, dtype)
    def all(self): return self
    def item(self): return self.torch.valid_half if self.dtype == 'bf16' else self.torch.valid_full


class FakeTorch:
    float32, bfloat16 = 'float32', 'bf16'
    def __init__(self, available=True, supported=True, valid_full=True, valid_half=True, half_error=False):
        self.available, self.supported = available, supported
        self.valid_full, self.valid_half, self.half_error = valid_full, valid_half, half_error
        self.cuda = self
    def is_available(self): return self.available
    def is_bf16_supported(self): return self.supported
    def synchronize(self): pass
    def ones(self, shape, *, device, dtype): return FakeTensor(self, dtype)
    def isfinite(self, value): return value


class ProbeTests(unittest.TestCase):
    def test_bf16_requires_working_device_computation(self):
        self.assertEqual(probe.select_dtype(FakeTorch()), 'bf16')
        for options in ({'supported': False}, {'valid_half': False}, {'half_error': True}):
            self.assertEqual(probe.select_dtype(FakeTorch(**options)), 'float32')
    def test_missing_or_broken_cuda_stops_provisioning(self):
        for options in ({'available': False}, {'valid_full': False}):
            with self.assertRaises(RuntimeError): probe.select_dtype(FakeTorch(**options))


if __name__ == '__main__': unittest.main()
