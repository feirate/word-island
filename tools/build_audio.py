#!/usr/bin/env python3
"""Build bundled demonstration speech using already-installed macOS voices only."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'audio'
RATE = 145
BIT_RATE = 48000


def run(args):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or f'{args[0]} failed')
    return result.stdout


def content():
    source = """
      import { WORDS, PHRASES } from './src/content.js';
      console.log(JSON.stringify([
        ...WORDS.map(w => ({id:`word-${w.id}`, key:`word:${w.id}`, text:w.en, kind:'word'})),
        ...PHRASES.map(p => ({id:`phrase-${p.id}`, key:`phrase:${p.id}`, text:p.en, kind:'phrase'})),
      ]));
    """
    return json.loads(run(['node', '--input-type=module', '-e', source]))


def audio_info(path):
    info = run(['/usr/bin/afinfo', str(path)])
    match = re.search(r'estimated duration:\s*([0-9.]+)\s*sec', info)
    if not match or float(match.group(1)) <= 0:
        raise RuntimeError(f'音频没有可验证的时长：{path.name}')
    if not re.search(r'Data format:.*\baac\s+\(', info):
        raise RuntimeError(f'音频编码不是 AAC：{path.name}')
    return float(match.group(1))


def choose_voice(directory):
    installed = run(['/usr/bin/say', '-v', '?'])
    errors = []
    for name, locale in [('Daniel', 'en_GB'), ('Samantha', 'en_US')]:
        if not re.search(rf'^{name}\s+{locale}\s+#', installed, re.MULTILINE):
            continue
        try:
            probe = directory / f'probe-{name}.aiff'
            run(['/usr/bin/say', '-v', name, '-r', str(RATE), '-o', str(probe), 'milk'])
            if not probe.exists() or probe.stat().st_size < 100:
                raise RuntimeError('未生成有效音频')
            return name, locale.replace('_', '-')
        except RuntimeError as error:
            errors.append(f'{name}: {error}')
    raise RuntimeError('本机 Daniel 和 Samantha 均无法离线合成；未下载任何声线。' + '；'.join(errors))


def verify():
    metadata = json.loads((OUTPUT / 'metadata.json').read_text(encoding='utf-8'))
    expected = content()
    if len(metadata.get('clips', [])) != len(expected):
        raise RuntimeError('音频条目数量与当前词表不一致。')
    for item in expected:
        clip = next((entry for entry in metadata['clips'] if entry['id'] == item['id']), None)
        if not clip or clip['text'] != item['text'] or clip['file'] != f"{item['id']}.m4a":
            raise RuntimeError(f"音频条目与当前内容不一致：{item['id']}")
        path = OUTPUT / clip['file']
        if hashlib.sha256(path.read_bytes()).hexdigest() != clip['sha256']:
            raise RuntimeError(f'音频内容校验失败：{path.name}')
        audio_info(path)
    print(f"已验证 {len(expected)} 段 AAC 音频，声线 {metadata['voice']}（{metadata['language']}），均为合成示范、非教材原音。")


def build():
    items = content()
    with tempfile.TemporaryDirectory(prefix='word-island-audio-') as temporary:
        staging = Path(temporary)
        voice, language = choose_voice(staging)
        clips = []
        print(f'使用本机已安装声线 {voice}（{language}），全程本地生成。', flush=True)
        for item in items:
            source = staging / f"{item['id']}.aiff"
            target = staging / f"{item['id']}.m4a"
            run(['/usr/bin/say', '-v', voice, '-r', str(RATE), '-o', str(source), item['text']])
            run(['/usr/bin/afconvert', '-f', 'm4af', '-d', 'aac @22050', '-b', str(BIT_RATE), '-c', '1', '--no-filler', str(source), str(target)])
            duration = audio_info(target)
            clips.append({**item, 'file': target.name, 'bytes': target.stat().st_size,
                          'durationSeconds': duration, 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
        metadata = {
            'app': 'word-island', 'version': 1,
            'generatedAt': datetime.now(timezone.utc).isoformat(),
            'engine': 'macOS /usr/bin/say', 'voice': voice, 'language': language,
            'accent': '英国英语' if language == 'en-GB' else '美国英语',
            'wordsPerMinute': RATE, 'format': 'AAC / M4A', 'sampleRateHz': 22050,
            'bitRate': BIT_RATE,
            'source': '本机已安装声线离线合成示范；非教材原音。短句是软件补充示例。',
            'networkServicesUsed': False, 'voiceDownloadsPerformed': False,
            'clips': clips,
        }
        OUTPUT.mkdir(parents=True, exist_ok=True)
        for clip in clips:
            (staging / clip['file']).replace(OUTPUT / clip['file'])
        (OUTPUT / 'metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    verify()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true', help='只验证现有音频和来源清单，不重新合成')
    args = parser.parse_args()
    try:
        verify() if args.verify else build()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f'音频构建未完成：{error}', file=sys.stderr)
        sys.exit(1)
