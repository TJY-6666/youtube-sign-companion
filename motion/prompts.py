"""Use the released optional sign-token dictionary without changing its prompt format."""
import json
from pathlib import Path


def load_dictionary(model_dir):
    filename = Path(model_dir) / "retrieval/word2code.json"
    if not filename.is_file():
        return {}
    if filename.stat().st_size > 8 * 1024 * 1024:
        raise ValueError("Sign-token dictionary exceeds the local limit")
    values = json.loads(filename.read_text(encoding="utf8"))
    if not isinstance(values, dict) or not values or len(values) > 30000:
        raise ValueError("Invalid sign-token dictionary")
    for word, entry in values.items():
        if not isinstance(word, str) or len(word) > 100 or not isinstance(entry, dict):
            raise ValueError("Invalid sign-token dictionary entry")
        streams = entry.get("tokens", entry)
        if not isinstance(streams, dict):
            raise ValueError("Invalid sign-token dictionary streams")
        for names, limit in [(('body',), 96), (('left', 'lhand'), 192), (('right', 'rhand'), 192)]:
            sequence = next((streams[name] for name in names if name in streams), None)
            if not isinstance(sequence, list) or not 1 <= len(sequence) <= 1000 or any(type(value) is not int or not 0 <= value < limit for value in sequence):
                raise ValueError("Invalid sign-token dictionary codes")
    return values


def prepare_prompt(text, vocab, dictionary):
    from robostar.retrieval import extract_keywords
    keywords = extract_keywords(text, dictionary, 3) if dictionary else []
    prompt = vocab.retrieval_prompt(text, keywords, dictionary) if dictionary else text
    return prompt, keywords
