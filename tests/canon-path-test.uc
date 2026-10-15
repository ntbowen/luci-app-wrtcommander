/*
 * Path-validation regression test for canon() and detect_binary().
 *
 * Runs anywhere ucode is available - it needs no router, no rpcd and no
 * ubus, because it lifts the two functions straight out of the shipped
 * backend and calls them directly. Lifting rather than copying means the
 * test cannot drift away from the code it is guarding.
 *
 * What it guards: both functions used to look for an embedded NUL byte
 * with `match(str, /\x00/)`. A ucode regex literal gives you no NUL
 * matcher there - the pattern collapses to one that matches the empty
 * string, so the call is truthy for *every* string. canon() therefore
 * answered "Invalid path" for every path it was ever given, and
 * detect_binary() called every file binary. The check is index() against
 * chr(0) now, which returns a byte offset or -1.
 */

import * as fs from 'fs';

let here = sourcepath(0, true) ?? '.';
let SRC = getenv('CANON_TEST_SRC') ?? (here + '/../root/usr/share/rpcd/ucode/wrtcommander.uc');

let src = fs.readfile(SRC);
if (!src) {
	warn('cannot read backend source at ' + SRC + '\n');
	exit(1);
}

/* Lift the named top-level functions out of the module. They start at
   column 0 with "function <name>(" and end at the next "}" in column 0. */
function lift(name) {
	let lines = split(src, '\n');
	let out = [], grabbing = false;
	for (let l in lines) {
		if (!grabbing && substr(l, 0, length(name) + 10) == 'function ' + name + '(') {
			grabbing = true;
			push(out, l);
			continue;
		}
		if (grabbing) {
			push(out, l);
			if (l == '}')
				break;
		}
	}
	if (!length(out))
		die('could not lift function ' + name + '() out of the backend source');
	return join('\n', out);
}

let ROOT = getenv('CANON_TEST_ROOT') ?? '/';

/* Everything canon() and detect_binary() reach for, either lifted from
   the real source or - for the two that would pull in uci and the whole
   error table - stubbed to something equivalent. */
let chunk = join('\n\n', [
	"let fs = require('fs');",
	"function get_config() { return { allowed_root: '" + ROOT + "' }; }",
	"function make_error(code, message) { return { code, message }; }",
	"function fail(code, message) { return { ok: false, error: make_error(code, message) }; }",
	"function fail_from_fs(context) { return fail('EIO', context + ': ' + fs.error()); }",
	lift('join_path'),
	lift('in_root'),
	lift('canon'),
	lift('detect_binary'),
	"return { canon, detect_binary };",
]);

let mod = loadstring(chunk);
if (!mod)
	die('the lifted code did not compile');
let M = mod();

let pass = 0, fail_count = 0;

function check(desc, cond, detail) {
	if (cond) {
		print('  ok   ' + desc + '\n');
		pass++;
	}
	else {
		print('  FAIL ' + desc + (detail ? ('  -> ' + detail) : '') + '\n');
		fail_count++;
	}
}

function describe(r) {
	if (r.err)
		return r.err.error.code + ' ' + r.err.error.message;
	return 'path=' + r.path;
}

let TMP = '/tmp/wrtcommander-canontest';
system(['rm', '-rf', TMP]);
fs.mkdir(TMP);

/* The names below are the ones that broke in the field: ordinary files
   whose only distinguishing feature is a space and a pair of brackets.
   They must survive canon() untouched. */
let NAMES = [
	'_normal (1).jpg',
	'plain.jpg',
	'file with spaces.txt',
	'скриншот (2).png',
	'a+b&c=d.txt',
	"quote'and\"quote.txt",
	'dash-and_under.tar.gz',
];

print('canon() accepts real filenames\n');
for (let n in NAMES) {
	let p = TMP + '/' + n;
	let fh = fs.open(p, 'w');
	if (fh) { fh.write('hello\n'); fh.close(); }
	let r = M.canon(p);
	check('accepts ' + n, r.path == p, describe(r));
}

print('canon() still rejects what it must\n');
check('rejects an embedded NUL byte',
	M.canon(TMP + '/pl' + chr(0) + 'ain.jpg').err?.error?.message == 'Path contains a NUL byte',
	describe(M.canon(TMP + '/pl' + chr(0) + 'ain.jpg')));
check('rejects the empty string, and says so',
	M.canon('').err?.error?.message == 'Path is empty',
	describe(M.canon('')));
check('rejects a non-string, and says so',
	M.canon(42).err?.error?.message == 'Path is not a string',
	describe(M.canon(42)));
check('rejects a relative path',
	M.canon('etc/passwd').err?.error?.code == 'EINVAL');
check('rejects a missing file when it must exist',
	M.canon(TMP + '/does-not-exist').err?.error?.code == 'ENOENT');
check('accepts a missing file when it need not exist',
	M.canon(TMP + '/does-not-exist', { must_exist: false }).path == TMP + '/does-not-exist');
check('normalises .. away rather than following it',
	M.canon(TMP + '/sub/../plain.jpg', { must_exist: false }).path == TMP + '/plain.jpg');
check('refuses a plain file where a directory is required',
	M.canon(TMP + '/plain.jpg', { must_be_dir: true }).err?.error?.code == 'ENOTDIR');

print('detect_binary() tells text from binary\n');
check('plain text is not binary', M.detect_binary('hello\nworld\n') == false);
check('empty content is not binary', M.detect_binary('') == false);
check('UTF-8 text is not binary', M.detect_binary('строка текста\n') == false);
check('content with a NUL byte is binary',
	M.detect_binary('MZ' + chr(0) + chr(0) + 'x') == true);
let long_text = '';
while (length(long_text) < 9000)
	long_text += 'abcdefghij';
check('a NUL past the 8000-byte sample is not looked for',
	M.detect_binary(long_text + chr(0)) == false);

system(['rm', '-rf', TMP]);

print('\n== ' + pass + ' passed, ' + fail_count + ' failed ==\n');
exit(fail_count ? 1 : 0);
