"""Stream the released F32 checkpoint without whole-file copy-on-write mappings."""
import hashlib
import json
from math import prod
from pathlib import Path
import struct
import sys
import torch

COPY_CHUNK_BYTES = 16 * 1024**2


def copy_checkpoint(model, folder):
    target = model.state_dict()
    seen = set()
    aliases, checksums = {}, {}
    for name, tensor in target.items():
        aliases.setdefault(tensor.data_ptr(), []).append(name)
    files = sorted(Path(folder).glob('*.safetensors'))
    if not files:
        raise ValueError('No safetensors checkpoint files found')
    for filename in files:
        with filename.open('rb') as handle:
            raw = handle.read(8)
            if len(raw) != 8:
                raise ValueError('Truncated checkpoint header')
            header_size = struct.unpack('<Q', raw)[0]
            if not 2 <= header_size <= 16 * 1024 * 1024:
                raise ValueError('Invalid checkpoint header size')
            raw_header = handle.read(header_size)
            header = json.loads(raw_header)
            if not isinstance(header, dict):
                raise ValueError('Invalid checkpoint tensor table')
            start = 8 + header_size
            size = filename.stat().st_size - start
            for name, entry in header.items():
                if name == '__metadata__':
                    continue
                if name not in target or name in seen:
                    raise ValueError(f'Unexpected or duplicate checkpoint tensor: {name}')
                if not isinstance(entry, dict) or entry.get('dtype') != 'F32':
                    raise ValueError('This loader accepts the released F32 checkpoint only')
                shape, offsets = entry.get('shape'), entry.get('data_offsets')
                if not isinstance(shape, list) or any(type(n) is not int or n < 0 for n in shape) or tuple(shape) != tuple(target[name].shape):
                    raise ValueError(f'Checkpoint shape mismatch: {name}')
                if not isinstance(offsets, list) or len(offsets) != 2 or any(type(n) is not int for n in offsets):
                    raise ValueError('Invalid checkpoint byte offsets')
                first, end = offsets
                count = end - first
                if first < 0 or end > size or count != prod(shape) * 4 or count > 2 * 1024**3:
                    raise ValueError('Checkpoint tensor is truncated or exceeds the size limit')
                handle.seek(start + first)
                pointer = target[name].data_ptr()
                if count:
                    if not target[name].is_contiguous():
                        raise ValueError(f'Expected contiguous released-model tensor: {name}')
                    destination = target[name].view(-1)
                    digest = hashlib.sha256() if len(aliases[pointer]) > 1 else None
                    with torch.no_grad():
                        for offset in range(0, count, COPY_CHUNK_BYTES):
                            length = min(COPY_CHUNK_BYTES, count - offset)
                            data = bytearray(length)
                            if handle.readinto(data) != length:
                                raise ValueError('Truncated checkpoint tensor')
                            if digest is not None:
                                digest.update(data)
                            value = torch.frombuffer(data, dtype=torch.float32)
                            destination[offset // 4:(offset + length) // 4].copy_(value)
                            del value, data
                    if digest is not None:
                        checksum = digest.digest()
                        if pointer in checksums and checksums[pointer] != checksum:
                            raise ValueError(f'Checkpoint disagrees with tied parameter: {name}')
                        checksums[pointer] = checksum
                seen.add(name)
    missing = set(target) - seen
    if missing:
        raise ValueError(f'Checkpoint is missing {len(missing)} model tensors')
    return len(seen)


def load_models(model_dir, base_dir, dtype):
    from robostar.checkpoints import read_json
    from robostar.config import GeneratorConfig, TokenizerConfig
    from robostar.generator import RoboSTARGenerator
    from robostar.tokenizer import RoboSTARTokenizer
    from robostar.vocabulary import RoboSTARVocabulary
    model_dir = Path(model_dir)
    values = read_json(model_dir / 'generator/config.json')
    values['model_path'] = str(base_dir)
    cfg = GeneratorConfig.from_mapping(values)
    vocab = RoboSTARVocabulary(str(base_dir), cfg.body_codes, cfg.hand_codes, cfg.use_compact_map)
    expected = read_json(model_dir / 'generator/vocab.json')
    for key in ('vocab_size', 'en_asl_id'):
        if int(expected[key]) != int(getattr(vocab, key)):
            raise ValueError(f'Vocabulary contract mismatch: {key}')
    print('Constructing CUDA generator...', file=sys.stderr, flush=True)
    previous_dtype = torch.get_default_dtype()
    try:
        torch.set_default_dtype(dtype)
        with torch.device('cuda'):
            generator = RoboSTARGenerator(cfg, vocab, backbone_init='config_only')
    finally:
        torch.set_default_dtype(previous_dtype)
    print('Streaming generator weights...', file=sys.stderr, flush=True)
    count = copy_checkpoint(generator, model_dir / 'generator')
    print(f'Loaded {count} generator tensor entries.', file=sys.stderr, flush=True)
    tokenizer = RoboSTARTokenizer(TokenizerConfig.from_mapping(read_json(model_dir / 'tokenizer/config.json')))
    copy_checkpoint(tokenizer, model_dir / 'tokenizer')
    return generator.eval(), vocab, tokenizer.to('cuda').eval()
