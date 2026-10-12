import sqlite3, json, hashlib, sys, pathlib

tag = sys.argv[1]
home = pathlib.Path('/home/proof')
db_path = home / '.openclaw/agents/main/agent/openclaw-agent.sqlite'
db = sqlite3.connect('file:' + str(db_path) + '?mode=ro', uri=True)
extension = next((home / 'stable-prefix/lib/node_modules/openclaw/node_modules').rglob('vec0.so'))
db.enable_load_extension(True)
db.load_extension(str(extension))
db.enable_load_extension(False)
names = [x[0] for x in db.execute("select name from sqlite_master where type='table' and name like 'memory_%' order by name")]
snapshot = {}
for name in names:
    cols = [x[1] for x in db.execute('pragma table_info("' + name + '")')]
    rows = []
    for row in db.execute('select * from "' + name + '"'):
        rows.append({k: ({'blob_sha256': hashlib.sha256(v).hexdigest(), 'bytes': len(v)} if isinstance(v, bytes) else v) for k, v in zip(cols, row)})
    snapshot[name] = sorted(rows, key=lambda x: json.dumps(x, sort_keys=True))
payload = json.dumps(snapshot, sort_keys=True, indent=2) + '\n'
pathlib.Path('/evidence/' + tag + '-memory-snapshot.json').write_text(payload)
print(json.dumps({'tag': tag, 'schema': db.execute('pragma user_version').fetchone()[0], 'memory_rows': {k: len(v) for k, v in snapshot.items() if v}, 'snapshot_sha256': hashlib.sha256(payload.encode()).hexdigest()}))
db.close()
