#!/usr/bin/env python3
"""Build offline speech using the already-installed premium Daniel voice.

Spoken text and source samples are preserved: bounded linear gain, 100 ms leading
silence, 200 ms trailing silence, then mono AAC encoding. No trimming or fading.
"""
import argparse
from array import array
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import wave

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'assets' / 'audio'
COMPARISON = ROOT / 'design' / 'audio-comparison'
SAMPLE_RATE = 22050
BIT_RATE = 48000
PROFILE = {
    'engine': 'macOS /usr/bin/say', 'voice': 'Daniel', 'language': 'en-GB',
    'voiceIdentifier': 'com.apple.speech.synthesis.voice.daniel.premium',
    'voiceQuality': 'premium', 'wordsPerMinute': 145,
    'rateMeaning': 'requested native system parameter, not measured words per minute',
    'format': 'AAC / M4A', 'sampleRateHz': SAMPLE_RATE, 'bitRate': BIT_RATE,
}
SLOW_PROFILE = {
    **{key: value for key, value in PROFILE.items() if key not in ['wordsPerMinute', 'rateMeaning']},
    'method': 'offline pitch-preserving time stretch', 'sourceWordsPerMinuteRequested': 145,
    'tempo': .82, 'pitchScale': 1, 'stretchEngine': 'FFmpeg librubberband',
}
PROCESSING = {
    'version': 1, 'method': 'bounded per-clip linear gain before padding',
    'targetMeanDbFS': -23, 'maxBoostDb': 4, 'maxPeakDbFS': -2,
    'paddingBeforeMs': 100, 'paddingAfterMs': 200,
    'trimSilence': False, 'fadeSpeech': False, 'dynamicCompression': False,
    'measurement': '22050 Hz mono decoded float PCM sample levels; silence threshold -55 dBFS',
}
COMPARISON_IDS = ['word-playground', 'phrase-kb3-hello-1', 'phrase-kb3-u8-2']


def run(args, binary=False):
    result = subprocess.run(args, cwd=ROOT, capture_output=True, text=not binary, timeout=30)
    if result.returncode:
        stderr = result.stderr.decode('utf-8', 'replace') if binary else result.stderr
        raise RuntimeError(stderr.strip() or f'{args[0]} failed')
    return result.stdout


def ffmpeg():
    executable = shutil.which('ffmpeg')
    if not executable:
        raise RuntimeError('本机未找到现有 FFmpeg；不会安装工具或调用云服务。')
    return executable


def content():
    source = """
      import { WORDS, PHRASES } from './src/content.js';
      console.log(JSON.stringify([
        ...WORDS.map(w => ({id:`word-${w.id}`, key:`word:${w.id}`, text:w.en, kind:'word'})),
        ...PHRASES.map(p => ({id:`phrase-${p.id}`, key:`phrase:${p.id}`, text:p.en, kind:'phrase'})),
      ]));
    """
    items = json.loads(run(['node', '--input-type=module', '-e', source]))
    if len({item['id'] for item in items}) != len(items):
        raise RuntimeError('词表或短句存在重复音频标识，不能覆盖同名文件。')
    for item in items:
        if not re.fullmatch(r'(?:word|phrase)-[A-Za-z0-9_-]+', item['id']) or not item['text'].strip():
            raise RuntimeError(f"音频标识或朗读文本无效：{item['id']}")
    return items


def audio_info(path):
    info = run(['/usr/bin/afinfo', str(path)])
    match = re.search(r'estimated duration:\s*([0-9.]+)\s*sec', info)
    if not match or float(match.group(1)) <= 0:
        raise RuntimeError(f'音频没有可验证的时长：{path.name}')
    if not re.search(r'Data format:.*\baac\s+\(', info):
        raise RuntimeError(f'音频编码不是 AAC：{path.name}')
    if not re.search(r'Data format:\s+1 ch,\s+22050 Hz,', info):
        raise RuntimeError(f'音频不是 22050 Hz 单声道：{path.name}')
    return float(match.group(1))


def decode_pcm(path, tempo=None):
    args = [ffmpeg(), '-v', 'error', '-i', str(path)]
    if tempo is not None:
        args += ['-af', f'rubberband=tempo={tempo}:pitch=1']
    data = run([*args, '-f', 'f32le', '-ac', '1', '-ar', str(SAMPLE_RATE), '-'], binary=True)
    samples = array('f')
    samples.frombytes(data)
    if sys.byteorder != 'little':
        samples.byteswap()
    if not samples:
        raise ValueError('合成音频没有采样数据。')
    # Keep float samples through measurement, including any codec/filter
    # overshoot; quantize only after bounded gain when writing the final WAV.
    return array('d', (sample * 32768 for sample in samples))


def levels(samples):
    if not samples:
        raise ValueError('音频采样不能为空。')
    peak = max(abs(sample) for sample in samples)
    if not peak:
        raise ValueError('合成音频只有静音，不能当作示范音保存。')
    mean_square = math.fsum(sample * sample for sample in samples) / len(samples)
    threshold = 32768 * 10 ** (-55 / 20)
    active = [index for index, sample in enumerate(samples) if abs(sample) > threshold]
    if not active:
        raise ValueError('合成音量低于可检测阈值，不能当作示范音保存。')
    return {
        'meanDbFS': round(10 * math.log10(mean_square / 32768 ** 2), 5),
        'peakDbFS': round(20 * math.log10(peak / 32768), 5),
        'durationSeconds': round(len(samples) / SAMPLE_RATE, 6),
        'leadingSilenceMs': round(active[0] * 1000 / SAMPLE_RATE, 3),
        'trailingSilenceMs': round((len(samples) - 1 - active[-1]) * 1000 / SAMPLE_RATE, 3),
    }


def gain_for_levels(mean_db, peak_db):
    if not math.isfinite(mean_db) or not math.isfinite(peak_db):
        raise ValueError('音量测量无效，不能放大静音。')
    return min(PROCESSING['targetMeanDbFS'] - mean_db, PROCESSING['maxBoostDb'],
               PROCESSING['maxPeakDbFS'] - peak_db)


def prepare_pcm(samples, gain_db):
    factor = 10 ** (gain_db / 20)
    speech = array('h', (max(-32768, min(32767, round(sample * factor))) for sample in samples))
    before = array('h', [0]) * (SAMPLE_RATE * PROCESSING['paddingBeforeMs'] // 1000)
    after = array('h', [0]) * (SAMPLE_RATE * PROCESSING['paddingAfterMs'] // 1000)
    return before + speech + after


def write_pcm(path, samples):
    data = array('h', samples)
    if sys.byteorder != 'little':
        data.byteswap()
    with wave.open(str(path), 'wb') as destination:
        destination.setnchannels(1)
        destination.setsampwidth(2)
        destination.setframerate(SAMPLE_RATE)
        destination.writeframes(data.tobytes())


def choose_voice():
    installed = run(['/usr/bin/say', '-v', '?'])
    if not re.search(r'^Daniel\s+en_GB\s+#', installed, re.MULTILINE):
        raise RuntimeError('本机未安装 Daniel 英音声线；不会下载声线或调用云服务。')
    info = Path('/System/Library/Speech/Voices/Daniel.SpeechVoice/Contents/Info.plist')
    if not info.is_file() or plistlib.loads(info.read_bytes()).get('CFBundleIdentifier') != PROFILE['voiceIdentifier']:
        raise RuntimeError('本机构建需要已安装的 premium Daniel 声线；不会下载或替换系统声线。')
    return PROFILE['voice']


def write_json_if_changed(path, value):
    text = json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    if not path.exists() or path.read_text(encoding='utf-8') != text:
        path.write_text(text, encoding='utf-8')


def write_precache(clips):
    files = [f"assets/audio/{clip['file']}" for clip in clips]
    source = '// Generated by tools/build_audio.py; all files are local synthetic demonstrations.\n'
    source += 'self.WORD_ISLAND_AUDIO_FILES = ' + json.dumps(files, ensure_ascii=False, indent=2) + ';\n'
    target = OUTPUT / 'precache.js'
    if not target.exists() or target.read_text(encoding='utf-8') != source:
        target.write_text(source, encoding='utf-8')


def variants(items, slow=False):
    rate = {'tempo': SLOW_PROFILE['tempo'], 'pitchScale': 1} if slow else {'wordsPerMinute': PROFILE['wordsPerMinute']}
    return [{**item, 'id': item['id'] + ('-slow' if slow else ''), 'baseId': item['id'],
             'rateMode': 'slow' if slow else 'normal', **rate} for item in items]


def validate_processing(clip, measured=None):
    processing = clip.get('processing', {})
    gain = processing.get('gainDb')
    if not isinstance(gain, (int, float)) or not math.isfinite(gain) or gain > PROCESSING['maxBoostDb']:
        raise ValueError(f"音频增益无效：{clip['id']}")
    for kind in ['source', 'pcm', 'encoded']:
        entry = processing.get(kind, {})
        if any(not isinstance(entry.get(key), (int, float)) or not math.isfinite(entry[key])
               for key in ['meanDbFS', 'peakDbFS', 'durationSeconds', 'leadingSilenceMs', 'trailingSilenceMs']):
            raise ValueError(f"音频测量信息无效：{clip['id']} {kind}")
    encoded = measured or processing['encoded']
    if processing['pcm']['peakDbFS'] > -1.999 or encoded['peakDbFS'] > -1.95:
        raise ValueError(f"音频峰值超过预留余量：{clip['id']}")
    if encoded['leadingSilenceMs'] < 70 or encoded['trailingSilenceMs'] < 150:
        raise ValueError(f"音频首尾保护留白不足：{clip['id']}")
    if measured and measured != processing['encoded']:
        raise ValueError(f"音频实测数据与清单不一致：{clip['id']}")


def reusable_clip(metadata, item, profile, old_clips):
    previous_profile = metadata.get('slowProfile', {}) if item['rateMode'] == 'slow' else metadata
    if any(previous_profile.get(key) != value for key, value in profile.items()) or metadata.get('processing') != PROCESSING:
        return None
    clip = old_clips.get(item['id'])
    if not clip or any(clip.get(key) != value for key, value in item.items()) or clip.get('file') != f"{item['id']}.m4a":
        return None
    path = OUTPUT / clip['file']
    if not path.is_file() or path.stat().st_size != clip.get('bytes') or hashlib.sha256(path.read_bytes()).hexdigest() != clip.get('sha256'):
        return None
    try:
        audio_info(path)
        validate_processing(clip, levels(decode_pcm(path)))
    except (RuntimeError, ValueError):
        return None
    return clip


def generate_clip(item, profile, staging):
    source = staging / f"{item['baseId']}.aiff"
    padded = staging / f"{item['id']}.wav"
    target = staging / f"{item['id']}.m4a"
    if not source.exists():
        run(['/usr/bin/say', '-v', PROFILE['voice'], '-r', str(PROFILE['wordsPerMinute']), '-o', str(source), item['text']])
    native = decode_pcm(source)
    samples = decode_pcm(source, SLOW_PROFILE['tempo']) if item['rateMode'] == 'slow' else native
    source_levels = levels(samples)
    gain = gain_for_levels(source_levels['meanDbFS'], source_levels['peakDbFS'])
    # AAC may overshoot a PCM sample peak: measure encoded output and lower only
    # linear gain if needed. There is no limiter, fade, trimming or compression.
    for correction in range(3):
        processed = prepare_pcm(samples, gain)
        pcm_levels = levels(processed)
        write_pcm(padded, processed)
        run(['/usr/bin/afconvert', '-f', 'm4af', '-d', 'aac @22050', '-b', str(BIT_RATE), '-c', '1', '--no-filler', str(padded), str(target)])
        encoded_levels = levels(decode_pcm(target))
        if encoded_levels['peakDbFS'] <= PROCESSING['maxPeakDbFS']:
            break
        gain -= encoded_levels['peakDbFS'] - PROCESSING['maxPeakDbFS'] + .05
    else:
        raise RuntimeError(f"AAC 编码峰值无法满足余量：{item['id']}")
    clip = {**item, 'file': target.name, 'bytes': target.stat().st_size,
            'durationSeconds': audio_info(target), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
            'processing': {'gainDb': round(gain, 7), 'peakCorrectionPasses': correction,
                           'nativePcmSha256': hashlib.sha256(native.tobytes()).hexdigest(),
                           'nativeSource': levels(native),
                           'source': source_levels, 'pcm': pcm_levels, 'encoded': encoded_levels}}
    validate_processing(clip)
    return clip


def preserve_original_examples(previous):
    manifest = COMPARISON / 'before.json'
    if manifest.exists():
        return
    old = {clip['id']: clip for clip in previous.get('clips', [])}
    if previous.get('processing') or not all(item in old for item in COMPARISON_IDS):
        return
    COMPARISON.mkdir(parents=True, exist_ok=True)
    for item in COMPARISON_IDS:
        source = OUTPUT / old[item]['file']
        destination = COMPARISON / f'before-{item}.m4a'
        if not destination.exists():
            shutil.copy2(source, destination)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != old[item]['sha256']:
            raise RuntimeError(f'原版试听样本校验不一致：{destination.name}')
    write_json_if_changed(manifest, {
        'source': '优化前的本地 Daniel 合成示范；非教材原音。',
        'voice': previous.get('voice'), 'wordsPerMinute': previous.get('wordsPerMinute'),
        'clips': [old[item] for item in COMPARISON_IDS],
    })


def comparison_files():
    if not (COMPARISON / 'before.json').exists():
        return
    for item in COMPARISON_IDS:
        for suffix, source in [('after', OUTPUT / f'{item}.m4a'), ('slow', OUTPUT / f'{item}-slow.m4a')]:
            target = COMPARISON / f'{suffix}-{item}.m4a'
            if not target.exists() or target.read_bytes() != source.read_bytes():
                shutil.copy2(source, target)
    manifest_path = COMPARISON / 'mp3-sources.json'
    previous = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else {}
    sources = {}
    for label, filename in [('before', 'before-phrase-kb3-hello-1.m4a'),
                            ('after-normal', 'after-phrase-kb3-hello-1.m4a'),
                            ('after-slow', 'slow-phrase-kb3-hello-1.m4a')]:
        source = COMPARISON / filename
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        target = COMPARISON / f'hello-{label}.mp3'
        if not target.exists() or previous.get(target.name) != digest:
            run([ffmpeg(), '-v', 'error', '-y', '-i', str(source), '-ac', '1', '-ar', '22050', '-b:a', '64000', str(target)])
        sources[target.name] = digest
    write_json_if_changed(manifest_path, sources)


def verify():
    metadata = json.loads((OUTPUT / 'metadata.json').read_text(encoding='utf-8'))
    items = content()
    if any(metadata.get(key) != value for key, value in PROFILE.items()) or metadata.get('slowProfile') != SLOW_PROFILE or metadata.get('processing') != PROCESSING:
        raise RuntimeError('音频声线、处理或双速参数与本地构建配置不一致。')
    if metadata.get('networkServicesUsed') is not False or metadata.get('voiceDownloadsPerformed') is not False or '非教材原音' not in metadata.get('source', ''):
        raise RuntimeError('音频清单缺少正确的本地合成来源声明。')
    all_clips = []
    for name, expected in [('clips', variants(items)), ('slowClips', variants(items, True))]:
        clips = metadata.get(name, [])
        if len(clips) != len(expected) or len({clip['id'] for clip in clips}) != len(clips):
            raise RuntimeError(f'音频清单数量或标识与当前词表不一致：{name}')
        for item, clip in zip(expected, clips):
            if any(clip.get(key) != value for key, value in item.items()) or clip['file'] != f"{item['id']}.m4a":
                raise RuntimeError(f"音频条目与当前内容不一致：{item['id']}")
            path = OUTPUT / clip['file']
            if path.stat().st_size != clip['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != clip['sha256']:
                raise RuntimeError(f'音频内容校验失败：{path.name}')
            if audio_info(path) != clip['durationSeconds']:
                raise RuntimeError(f'音频时长与清单不一致：{path.name}')
            validate_processing(clip, levels(decode_pcm(path)))
        all_clips.extend(clips)
    files = json.loads((OUTPUT / 'precache.js').read_text(encoding='utf-8').split('self.WORD_ISLAND_AUDIO_FILES = ', 1)[1].rstrip().removesuffix(';'))
    if files != [f"assets/audio/{clip['file']}" for clip in all_clips]:
        raise RuntimeError('离线音频清单与双速音频不一致。')
    for normal, slow in zip(metadata['clips'], metadata['slowClips']):
        if slow['text'] != normal['text'] or slow['durationSeconds'] <= normal['durationSeconds'] or slow['processing']['nativePcmSha256'] != normal['processing']['nativePcmSha256']:
            raise RuntimeError(f"慢读文本或时长不符合预期：{normal['id']}")
        ratio = slow['processing']['source']['durationSeconds'] / normal['processing']['source']['durationSeconds']
        if not 1.17 <= ratio <= 1.27:
            raise RuntimeError(f"慢读发音区长度没有体现保音高伸展：{normal['id']}")
    print(f"已验证 {len(all_clips)} 段 AAC 音频（常速 {len(items)}、慢读 {len(items)}），Daniel 英音，合成示范、非教材原音。", flush=True)


def build():
    items = content()
    previous_path = OUTPUT / 'metadata.json'
    previous = json.loads(previous_path.read_text(encoding='utf-8')) if previous_path.exists() else {}
    preserve_original_examples(previous)
    old_clips = {clip['id']: clip for name in ['clips', 'slowClips'] for clip in previous.get(name, [])}
    with tempfile.TemporaryDirectory(prefix='word-island-audio-') as temporary:
        staging = Path(temporary)
        choose_voice()
        groups = {}
        generated = []
        reused = 0
        print('使用本机 premium Daniel；慢读为离线保音高 0.82 倍速度，无下载或云服务。', flush=True)
        for name, profile, entries in [('clips', PROFILE, variants(items)), ('slowClips', SLOW_PROFILE, variants(items, True))]:
            groups[name] = []
            for item in entries:
                existing = reusable_clip(previous, item, profile, old_clips)
                if existing:
                    groups[name].append(existing)
                    reused += 1
                    continue
                clip = generate_clip(item, profile, staging)
                groups[name].append(clip)
                generated.append(clip['file'])
                if len(generated) % 20 == 0 or len(generated) == len(items) * 2:
                    print(f'已生成 {len(generated)} 段，复用 {reused} 段。', flush=True)
        metadata = {
            'app': 'word-island', 'version': 2,
            'generatedAt': datetime.now(timezone.utc).isoformat() if generated else previous.get('generatedAt', datetime.now(timezone.utc).isoformat()),
            **PROFILE, 'slowProfile': SLOW_PROFILE, 'processing': PROCESSING, 'accent': '英国英语',
            'source': '本机已安装 premium Daniel 声线离线合成示范；非教材原音。常速用系统参数145导出，慢读由同一发音PCM离线保音高伸展至0.82倍速度；文本不变，两速均温和增益及首尾留白。',
            'nativeRateTrial': {'requestedNormal': 145, 'requestedSlow': 120, 'testedIds': COMPARISON_IDS,
                                'result': 'identical duration and decoded PCM for these pilot pairs; offline pitch-preserving stretch selected'},
            'networkServicesUsed': False, 'voiceDownloadsPerformed': False, **groups,
        }
        OUTPUT.mkdir(parents=True, exist_ok=True)
        for filename in generated:
            (staging / filename).replace(OUTPUT / filename)
        write_json_if_changed(previous_path, metadata)
        write_precache(groups['clips'] + groups['slowClips'])
        print(f'完成：复用 {reused} 段，新增 {len(generated)} 段。', flush=True)
    comparison_files()
    verify()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify', action='store_true', help='只验证双速音频、处理测量和来源清单，不重新合成')
    args = parser.parse_args()
    try:
        verify() if args.verify else build()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired) as error:
        print(f'音频构建未完成：{error}', file=sys.stderr)
        sys.exit(1)
