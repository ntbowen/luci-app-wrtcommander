#!/usr/bin/env python3
"""
Extract translatable strings from the Wrt Commander LuCI view into a
gettext .pot template.

LuCI's own build uses xgettext with custom keywords (build/i18n-scan.pl);
this small extractor keeps po/templates/wrtcommander.pot in sync the same
way without needing the LuCI build host tools, so the template can be
refreshed anywhere, not only inside a buildroot.

It collects strings from two places, matching what LuCI's own
build-time scan does:

  * the JS view, in the two forms it actually uses:

        _('single string')
        N_(count, 'singular', 'plural')

  * the "title" of each entry in the LuCI menu definition. Menu titles
    are translated through the same catalog at runtime (upstream apps
    list e.g. "menu.d/luci-app-ddns.json:3" as a source for their menu
    title msgid), which is what lets the sidebar entry appear in the
    user's language.

Important: the browser-side _() in LuCI's cbi.js normalises the lookup
key with trimws() (strip, then collapse internal whitespace runs to a
single space). Any msgid whose whitespace is not already normalised
would therefore never match at runtime, so this script refuses to emit
such strings and reports them instead.

Usage:  python3 po/extract.py
"""

import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOURCE = os.path.join(ROOT, 'htdocs/luci-static/resources/view/wrtcommander.js')
MENU = os.path.join(ROOT, 'root/usr/share/luci/menu.d/luci-app-wrtcommander.json')
OUTPUT = os.path.join(HERE, 'templates/wrtcommander.pot')

STR = r"'((?:[^'\\]|\\.)*)'"
# N_(n, singular, plural) with an optional fourth message-context
# argument, which is what every call in this app now passes - see the note
# about the shared key space in po/README.md
RE_PLURAL = re.compile(r"N_\(\s*[^,]+,\s*" + STR + r"\s*,\s*" + STR +
                       r"\s*(?:,\s*" + STR + r"\s*)?\)", re.S)
RE_SINGLE = re.compile(r"(?<![A-Za-z0-9_])_\(\s*" + STR + r"\s*\)")
# _('text', 'context') - a disambiguating message context, see po/README.md
RE_CTXT = re.compile(r"(?<![A-Za-z0-9_])_\(\s*" + STR + r"\s*,\s*" + STR + r"\s*\)")


def unescape_js(s):
    return s.replace("\\'", "'").replace('\\\\', '\\')


def po_escape(s):
    return s.replace('\\', '\\\\').replace('"', '\\"')


def menu_titles():
    """Every "title" in the LuCI menu definition."""
    try:
        spec = json.load(open(MENU, encoding='utf-8'))
    except FileNotFoundError:
        return set()
    return {entry['title'] for entry in spec.values()
            if isinstance(entry, dict) and isinstance(entry.get('title'), str)}


def main():
    src = open(SOURCE, encoding='utf-8').read()

    plurals = sorted({(unescape_js(a), unescape_js(b), unescape_js(c))
                      for a, b, c in RE_PLURAL.findall(src)})
    plural_singulars = {a for a, _b, _c in plurals}
    contexts = sorted({(unescape_js(s), unescape_js(c))
                       for s, c in RE_CTXT.findall(src)})
    singles = sorted(({unescape_js(s) for s in RE_SINGLE.findall(src)}
                      | menu_titles())
                     - plural_singulars)

    bad = [s for s in singles + [x for p in plurals for x in p if x]
           + [x for p in contexts for x in p]
           if s != ' '.join(s.split())]
    if bad:
        print('Refusing to write: these msgids are not whitespace-normalised,',
              'so the runtime trimws() lookup would never match them:',
              file=sys.stderr)
        for s in bad:
            print('  %r' % s, file=sys.stderr)
        return 1

    out = [
        'msgid ""',
        'msgstr ""',
        '"Content-Type: text/plain; charset=UTF-8\\n"',
        '"Content-Transfer-Encoding: 8bit\\n"',
        '"Project-Id-Version: luci-app-wrtcommander\\n"',
        '"Plural-Forms: nplurals=2; plural=(n != 1);\\n"',
        '',
    ]

    for s in singles:
        out.append('msgid "%s"' % po_escape(s))
        out.append('msgstr ""')
        out.append('')

    for s, c in contexts:
        out.append('msgctxt "%s"' % po_escape(c))
        out.append('msgid "%s"' % po_escape(s))
        out.append('msgstr ""')
        out.append('')

    for a, b, c in plurals:
        if c:
            out.append('msgctxt "%s"' % po_escape(c))
        out.append('msgid "%s"' % po_escape(a))
        out.append('msgid_plural "%s"' % po_escape(b))
        out.append('msgstr[0] ""')
        out.append('msgstr[1] ""')
        out.append('')

    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(out))

    print('%s: %d singular, %d plural' % (
        os.path.relpath(OUTPUT, ROOT), len(singles), len(plurals)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
