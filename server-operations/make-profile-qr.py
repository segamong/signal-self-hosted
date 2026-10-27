"""Encode locally generated profiles without sending credentials to a website."""
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
sys.path.insert(0, str(root / 'vendor' / 'qrcode-8.2-py3-none-any.whl'))
import qrcode
from PIL import Image

for device in ['Windows', 'Android']:
    profile = root / 'private' / ('Signal-' + device + '.txt')
    uri = profile.read_text(encoding='utf-8-sig').strip()
    assert uri.startswith('vless://') and '@vpn.signal-on.ru:443?' in uri
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=8, border=4)
    code.add_data(uri)
    code.make(fit=True)
    target = profile.with_suffix('.png')
    code.make_image(fill_color='black', back_color='white').save(target)
    with Image.open(target) as picture:
        picture.verify()
    print(device + ' profile QR generated locally: ' + target.name)
