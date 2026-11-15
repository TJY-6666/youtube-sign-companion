import json
from pathlib import Path
import sys
import tempfile
import unittest
from prompts import load_dictionary, prepare_prompt

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tmp/robostar-src'))
from robostar.vocabulary import RoboSTARVocabulary


class PromptTests(unittest.TestCase):
    def test_missing_optional_dictionary_stays_plain_text(self):
        with tempfile.TemporaryDirectory() as folder:
            self.assertEqual(load_dictionary(folder), {})
        self.assertEqual(prepare_prompt('Hello.', None, {}), ('Hello.', []))

    def test_official_prompt_keeps_english_and_uses_released_aliases(self):
        dictionary = {'HELLO': {'body': [1, 2], 'lhand': [3], 'rhand': [4]}}
        vocab = object.__new__(RoboSTARVocabulary)
        prompt, keywords = prepare_prompt('Hello.', vocab, dictionary)
        self.assertEqual(keywords, ['HELLO'])
        self.assertEqual(prompt, 'English: Hello.\nRetrieved sign-token hints:\n- HELLO: body=1 2; left=3; right=4')
        self.assertEqual(prepare_prompt('No match.', vocab, dictionary), ('English: No match.', []))

    def test_invalid_dictionary_codes_and_structure_fail_explicitly(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'retrieval/word2code.json'; path.parent.mkdir()
            for entry in [[], {'HELLO': {}}, {'HELLO': {'tokens': None}}, {'HELLO': {'body': [96], 'lhand': [0], 'rhand': [0]}}, {'HELLO': {'body': [True], 'lhand': [0], 'rhand': [0]}}]:
                path.write_text(json.dumps(entry), encoding='utf8')
                with self.assertRaises(ValueError):
                    load_dictionary(folder)
            path.write_text(json.dumps({'HELLO': {'body': [0], 'lhand': [0], 'rhand': [0]}}), encoding='utf8')
            self.assertEqual(len(load_dictionary(folder)), 1)


if __name__ == '__main__':
    unittest.main()
