"""Atomic writes for the files the build COMMITS: a temp file beside the target, then
os.replace.  A generator that dies mid-dump leaves the old file, never a truncated one.
Imports nothing of ours, so every generator can use it."""
import json
import os
import tempfile


def write_text(path, text):
    """Replace `path` with `text` in one step."""
    d = os.path.dirname(os.path.abspath(path)) or '.'
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.' + os.path.basename(path) + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'w') as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def write_json(path, doc, indent=1, separators=None):
    """Replace `path` with `doc` as JSON — same bytes `json.dump` would have written."""
    write_text(path, json.dumps(doc, indent=indent, separators=separators))
