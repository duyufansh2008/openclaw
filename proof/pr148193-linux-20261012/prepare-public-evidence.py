import base64, hashlib, json, pathlib, re, shutil

root = pathlib.Path('/root/pr148193-proof')
evidence = root / 'evidence'
out = root / 'public-evidence'
out.mkdir(exist_ok=True)
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()

def redact(value):
    if isinstance(value, dict):
        return {k: ('[REDACTED SYNTHETIC LOCAL MARKER]' if k.lower() in {'apikey', 'authorization', 'accesstoken', 'refreshtoken'} else redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value

cli_diagnostics = {}
def load(name):
    text = (evidence / name).read_text()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        candidates = []
        for match in re.finditer(r'[\[{]', text):
            try:
                value, consumed = json.JSONDecoder().raw_decode(text[match.start():])
                candidates.append((consumed, match.start(), value))
            except json.JSONDecodeError:
                pass
        consumed, start, value = max(candidates, key=lambda item: item[0])
        cli_diagnostics[name] = {'beforeJson': text[:start], 'afterJson': text[start + consumed:]}
        return value

json_names = [
    'published-update-summary.json', 'baseline-memory-snapshot.json',
    'post-update-memory-snapshot.json', 'post-update-after-search-memory-snapshot.json',
    'baseline-memory-search.json', 'baseline-memory-status.json',
    'post-update-memory-search.json', 'post-update-memory-search-repeat.json',
    'post-update-memory-status.json', 'post-media-ordinary-memory-search.json',
    'post-media-ordinary-memory-status.json', 'baseline-config.json',
    'before-media-config.json', 'after-ordinary-config.json', 'fresh-config-before.json',
    'code-mode-identities.json', 'code-mode-results.json', 'code-mode-run.json',
    'code-mode-run-history.json', 'native-models-after-code-mode.json',
    'failure-preservation.json', 'chat-fixture-integrity-metadata.json',
    'structured-agent-run.json', 'structured-agent-history.json',
    'decline-preservation.json',
]
data = {name: redact(load(name)) for name in json_names}
data['_cliDiagnostics'] = cli_diagnostics
assert load('baseline-memory-snapshot.json') == load('post-update-memory-snapshot.json')
assert load('failure-preservation.json')['exact'] is True
(out / 'evidence.json').write_text(json.dumps(data, indent=2) + '\n')

ansi = re.compile(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))')
terminal_names = [
    'baseline-embedding-setup-cached.terminal.log', 'baseline-memory-index-fixed.log',
    'published-updater-to-candidate.log', 'fresh-media-decline.terminal.log',
    'fresh-media-setup.terminal.log', 'fresh-ocr-cli.json', 'fresh-vision-cli.json',
    'existing-media-setup.terminal.log', 'ordinary-setup-after-media.terminal.log',
    'oversized-router-isolated.terminal.log', 'verification-failure.terminal.log',
    'structured-sdk-proof.jsonl',
    'fresh-media-decline-repeat.terminal.log',
]
terminal_manifest = []
for name in terminal_names:
    raw = evidence / name
    lines = []
    omitted = 0
    progress_samples = set()
    cleaned = ansi.sub('', raw.read_text())
    cleaned = re.sub(r'(?=[◒◐◓◑])', '\n', cleaned)
    cleaned = re.sub(r'(?=\[(?:provider-local-service|provider-transport-fetch)\])', '\n', cleaned)
    for line in re.split(r'[\r\n]+', cleaned):
        line = line.rstrip()
        # Only omit transient spinner/progress repaint lines; retain diagnostics and results.
        if re.match(r'^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑]', line) or re.search(r'Downloading .*\d+(?:\.\d+)?%', line):
            sample = re.sub(r'^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◒◐◓◑]\s*', '', line).rstrip('.… ')
            percent = re.match(r'(.+?): (\d+)%', sample)
            key = (percent[1], int(percent[2]) // 25) if percent else sample
            if key not in progress_samples and len(sample) < 250:
                lines.append('[progress sample] ' + sample)
                progress_samples.add(key)
            else:
                omitted += 1
            continue
        if line and (not lines or line != lines[-1]):
            lines.append(line)
    dest = out / ('logs/' + name + '.txt')
    dest.parent.mkdir(exist_ok=True)
    dest.write_text('\n'.join(lines) + '\n')
    terminal_manifest.append({'source': name, 'rawSha256': sha(raw), 'cleanedPath': str(dest.relative_to(out)), 'cleanedSha256': sha(dest), 'omittedProgressLines': omitted})

for name in ['baseline-native-preset.ini', 'before-media-native-preset.ini', 'after-ordinary-native-preset.ini']:
    shutil.copyfile(evidence / name, out / name)
for name in ['local-image-proof-final.js', 'structured-sdk-proof.mjs', 'snapshot.py']:
    shutil.copyfile(root / 'runtime' / name, out / name)
shutil.copyfile(root / 'run-isolated', out / 'run-isolated.sh')
for name in ['ocr.png', 'vision.png']:
    shutil.copyfile(root / 'runtime/home/workspace' / name, out / name)

artifacts = []
for p in sorted((root / 'runtime/home/fresh-state/models/llama.cpp').glob('*.gguf')):
    artifacts.append({'file': p.name, 'bytes': p.stat().st_size, 'sha256': sha(p)})
artifacts.append({'file': 'openclaw-pr148193.tgz', 'bytes': (root / 'artifacts/openclaw-pr148193.tgz').stat().st_size, 'sha256': sha(root / 'artifacts/openclaw-pr148193.tgz')})
manifest = {'candidateCommit': '8c68e283f3145d6455956867c81902ca7f908b43', 'artifacts': artifacts, 'terminalTransforms': terminal_manifest, 'fixtures': {n: sha(out / n) for n in ['ocr.png', 'vision.png']}, 'rawJsonSha256': {n: sha(evidence / n) for n in json_names}}
manifest['installedBuildInfo'] = {prefix: json.loads((root / f'runtime/home/{prefix}/lib/node_modules/openclaw/dist/build-info.json').read_text()) for prefix in ['candidate-prefix', 'stable-prefix']}
manifest['publishedNpmMetadata'] = {name: {k: load(name)[k] for k in ['version', 'dist']} for name in ['stable-package-metadata.json', 'stable-plugin-metadata.json']}
(out / 'integrity.json').write_text(json.dumps(manifest, indent=2) + '\n')
shutil.copyfile(root / 'prepare-public-evidence.py', out / 'prepare-public-evidence.py')
print(json.dumps({'files': len(list(out.rglob('*'))), 'bytes': sum(p.stat().st_size for p in out.rglob('*') if p.is_file()), 'tables': len(load('baseline-memory-snapshot.json')), 'rows': sum(len(v) for v in load('baseline-memory-snapshot.json').values())}))
