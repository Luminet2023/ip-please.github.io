"""Regression checks for transparent character PNG imports."""
import unittest
import contextlib
import io
import tempfile
from pathlib import Path
from unittest.mock import patch
from PIL import Image
import import_aicast
from import_aicast import strip_background, to_sprite


class TransparencyTest(unittest.TestCase):
    def test_existing_alpha_and_dark_details_are_preserved(self):
        im = Image.new("RGBA", (360, 256), (0, 0, 0, 0))
        im.paste((0, 0, 0, 255), (90, 10, 270, 256))
        im.putpixel((180, 80), (0, 0, 0, 0))
        im.putpixel((90, 100), (60, 70, 80, 127))
        result = strip_background(im)
        self.assertEqual(result.tobytes(), im.tobytes())
        sprite = to_sprite(result)
        self.assertEqual(sprite.getpixel((0, 0))[3], 0)
        self.assertEqual(sprite.getpixel((90, 30)), (0, 0, 0, 255))

    def test_small_transparent_area_is_still_preserved(self):
        im = Image.new("RGBA", (40, 40), (20, 30, 40, 255))
        im.putpixel((0, 0), (0, 0, 0, 0))
        self.assertEqual(strip_background(im).tobytes(), im.tobytes())

    def test_opaque_background_fallback_keeps_foreground(self):
        im = Image.new("RGB", (20, 20), (0, 0, 0))
        im.paste((230, 180, 120), (5, 5, 15, 20))
        result = strip_background(im)
        self.assertEqual(result.getpixel((0, 0))[3], 0)
        self.assertEqual(result.getpixel((10, 10))[3], 255)

    def test_reimport_replaces_stale_fallback_expressions(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'source' / 'Qwen').mkdir(parents=True)
            im = Image.new('RGBA', (360, 256), (0, 0, 0, 0))
            im.paste((230, 180, 120, 255), (90, 10, 270, 256))
            im.save(root / 'source' / 'Qwen' / 'neutral.png')
            booth = root / 'output' / 'QWEN_AI' / 'booth'
            booth.mkdir(parents=True)
            Image.new('RGBA', (180, 128), (0, 0, 0, 255)).save(booth / 'QWEN_AI_shock_180x128.png')
            with patch.object(import_aicast, 'OUT_ROOT', root / 'output'), patch('sys.argv', ['import_aicast.py', '--src', str(root / 'source')]), contextlib.redirect_stdout(io.StringIO()):
                import_aicast.main()
            with Image.open(booth / 'QWEN_AI_shock_180x128.png') as result:
                self.assertEqual(result.getpixel((0, 0))[3], 0)


if __name__ == "__main__":
    unittest.main()
