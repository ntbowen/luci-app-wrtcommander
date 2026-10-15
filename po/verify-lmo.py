#!/usr/bin/env python3
"""
Independently verify a compiled .lmo catalog against its .po source.

The .lmo is produced by LuCI's own po2lmo (see po/README.md). This
script deliberately does NOT reuse that code: it reimplements both the
SuperFastHash key derivation and the .lmo container format from scratch,
so that agreement between the two is real evidence the catalog is
correct rather than the same bug twice.

What it checks, per message in the .po:

  * the key the *browser* will look up is present in the catalog
    (LuCI's client-side _() in cbi.js hashes trimws(msgid) and indexes
    window.TR by the resulting 8-hex-digit value, so the hash computed
    here is byte-for-byte the one the browser computes)
  * the stored value is exactly the expected msgstr
  * plural forms are stored under "msgid\\x02<index>" keys
  * the Plural-Forms expression is stored under key id 0

Usage:  python3 po/verify-lmo.py po/ru/wrtcommander.po \\
                /tmp/wrtcommander.ru.lmo

        (any .lmo works - one built locally with po2lmo, or the catalog
        unpacked from a luci-i18n-wrtcommander-*.apk)
"""

import re
import struct
import sys

M32 = 0xFFFFFFFF


def sfh_hash(data: bytes, init: int) -> int:
    """SuperFastHash exactly as luci-base/src/lib/lmo.c computes it."""
    if len(data) == 0:
        return 0

    def u16(off):
        return data[off] | (data[off + 1] << 8)

    def s8(off):
        v = data[off]
        return v - 256 if v > 127 else v

    hash_ = init & M32
    rem = len(data) & 3
    nwords = len(data) >> 2
    off = 0

    for _ in range(nwords):
        hash_ = (hash_ + u16(off)) & M32
        tmp = ((u16(off + 2) << 11) ^ hash_) & M32
        hash_ = ((hash_ << 16) ^ tmp) & M32
        off += 4
        hash_ = (hash_ + (hash_ >> 11)) & M32

    if rem == 3:
        hash_ = (hash_ + u16(off)) & M32
        hash_ = (hash_ ^ (hash_ << 16)) & M32
        hash_ = (hash_ ^ ((s8(off + 2) << 18) & M32)) & M32
        hash_ = (hash_ + (hash_ >> 11)) & M32
    elif rem == 2:
        hash_ = (hash_ + u16(off)) & M32
        hash_ = (hash_ ^ (hash_ << 11)) & M32
        hash_ = (hash_ + (hash_ >> 17)) & M32
    elif rem == 1:
        hash_ = (hash_ + s8(off)) & M32
        hash_ = (hash_ ^ (hash_ << 10)) & M32
        hash_ = (hash_ + (hash_ >> 1)) & M32

    hash_ = (hash_ ^ (hash_ << 3)) & M32
    hash_ = (hash_ + (hash_ >> 5)) & M32
    hash_ = (hash_ ^ (hash_ << 4)) & M32
    hash_ = (hash_ + (hash_ >> 17)) & M32
    hash_ = (hash_ ^ (hash_ << 25)) & M32
    hash_ = (hash_ + (hash_ >> 6)) & M32
    return hash_


def key_id(key: str) -> int:
    raw = key.encode('utf-8')
    return sfh_hash(raw, len(raw))


def parse_lmo(path):
    """Return {key_id: value_bytes} plus the raw entry list."""
    blob = open(path, 'rb').read()
    if len(blob) < 4:
        raise SystemExit('%s: too short to be an .lmo' % path)

    (data_len,) = struct.unpack('>I', blob[-4:])
    index = blob[data_len:-4]
    if len(index) % 16 != 0:
        raise SystemExit('%s: index size %d is not a multiple of 16'
                         % (path, len(index)))

    out = {}
    entries = []
    for i in range(0, len(index), 16):
        kid, vid, off, length = struct.unpack('>IIII', index[i:i + 16])
        entries.append((kid, vid, off, length))
        out[kid] = blob[off:off + length]
    return out, entries


def parse_po(path):
    """Minimal .po reader: yields (msgid, msgid_plural, [msgstrs], msgctxt)."""
    msgs = []
    cur = {'id': None, 'plural': None, 'strs': {}, 'ctxt': None}
    pending_ctxt = None
    field = None
    idx = 0

    def flush():
        if cur['id'] is not None:
            msgs.append((cur['id'], cur['plural'],
                         [cur['strs'][k] for k in sorted(cur['strs'])],
                         cur['ctxt']))

    for raw in open(path, encoding='utf-8'):
        line = raw.rstrip('\n')
        if not line.strip() or line.lstrip().startswith('#'):
            continue

        m = re.match(r'^msgctxt "(.*)"$', line)
        if m:
            flush()
            cur = {'id': None, 'plural': None, 'strs': {}, 'ctxt': None}
            pending_ctxt = unescape(m.group(1))
            field = 'ctxt'
            continue

        m = re.match(r'^msgid "(.*)"$', line)
        if m:
            if pending_ctxt is None:
                flush()
            cur = {'id': unescape(m.group(1)), 'plural': None, 'strs': {},
                   'ctxt': pending_ctxt}
            pending_ctxt = None
            field = 'id'
            continue
        m = re.match(r'^msgid_plural "(.*)"$', line)
        if m:
            cur['plural'] = unescape(m.group(1))
            field = 'plural'
            continue
        m = re.match(r'^msgstr\[(\d+)\] "(.*)"$', line)
        if m:
            idx = int(m.group(1))
            cur['strs'][idx] = unescape(m.group(2))
            field = 'str'
            continue
        m = re.match(r'^msgstr "(.*)"$', line)
        if m:
            idx = 0
            cur['strs'][0] = unescape(m.group(1))
            field = 'str'
            continue
        m = re.match(r'^"(.*)"$', line)
        if m:
            piece = unescape(m.group(1))
            if field == 'ctxt':
                pending_ctxt += piece
            elif field == 'id':
                cur['id'] += piece
            elif field == 'plural':
                cur['plural'] += piece
            elif field == 'str':
                cur['strs'][idx] = cur['strs'].get(idx, '') + piece
            continue

    flush()
    return msgs


def unescape(s):
    return (s.replace('\\n', '\n').replace('\\t', '\t')
             .replace('\\"', '"').replace('\\\\', '\\'))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    po_path, lmo_path = sys.argv[1], sys.argv[2]

    catalog, entries = parse_lmo(lmo_path)
    msgs = parse_po(po_path)

    ok = 0
    identical = 0
    problems = []
    checked_plural_header = False

    for msgid, plural, strs, ctxt in msgs:
        if msgid == '':
            # header: po2lmo stores only the Plural-Forms expression, key 0
            header = strs[0] if strs else ''
            m = re.search(r'Plural-Forms:\s*(.*)', header)
            if m:
                want = m.group(1).split('\n')[0].strip()
                got = catalog.get(0, b'').decode('utf-8')
                if got.strip() == want:
                    ok += 1
                    checked_plural_header = True
                else:
                    problems.append('Plural-Forms mismatch:\n  want %r\n  got  %r'
                                    % (want, got))
            continue

        # po2lmo builds the lookup key as
        #   ctxt \1 id \2 n   /   ctxt \1 id   /   id \2 n   /   id
        # and LuCI's client-side _() / N_() build the very same string.
        prefix = (ctxt + '\x01') if ctxt else ''
        if plural is None:
            targets = [(prefix + msgid, strs[0] if strs else '')]
        else:
            targets = [('%s%s\x02%d' % (prefix, msgid, i), s)
                       for i, s in enumerate(strs)]

        for key, want in targets:
            if want == '':
                continue  # untranslated, legitimately absent
            kid = key_id(key)
            if kid not in catalog:
                # po2lmo drops an entry whose value hashes the same as its
                # key (po2lmo.c: `if (key_id != val_id)`), which is the
                # case for a string deliberately left as-is in this
                # language - a product name, say. The runtime then falls
                # back to the msgid and produces exactly that string, so
                # the absence is correct rather than a missing entry.
                if key_id(want) == kid:
                    identical += 1
                    continue
                problems.append('missing key %08x for %r' % (kid, key))
                continue
            got = catalog[kid].decode('utf-8')
            if got != want:
                problems.append('value mismatch for %r:\n  want %r\n  got  %r'
                                % (key, want, got))
                continue
            ok += 1

    print('%s -> %s' % (po_path, lmo_path))
    print('  index entries in catalog : %d' % len(entries))
    print('  verified lookups         : %d' % ok)
    if identical:
        print('  left as source on purpose: %d' % identical)
    print('  Plural-Forms stored      : %s' % ('yes' if checked_plural_header else 'NO'))

    if problems:
        print('  PROBLEMS                 : %d' % len(problems))
        for p in problems:
            print('    - %s' % p)
        return 1

    print('  PROBLEMS                 : none')
    return 0


if __name__ == '__main__':
    sys.exit(main())
