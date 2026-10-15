/*
 * Wrt Commander - rpcd/ubus backend
 *
 * Registers the "luci.wrtcommander" ubus object. Loaded by rpcd's ucode
 * plugin loader (rpcd-mod-ucode) from /usr/share/rpcd/ucode/.
 *
 * Every filesystem-affecting operation funnels through canon() before
 * touching the filesystem: this is the single path validation layer
 * required by the security model (normalize -> resolve -> symlink
 * handling -> containment check). No shell is ever invoked with
 * user-controlled strings; the one place that execs an external tool
 * (df) uses the array form of fs.popen(), which executes via execvp()
 * with a literal argv and never passes through /bin/sh.
 */

'use strict';

import * as fs from 'fs';
import * as uci from 'uci';
import * as math from 'math';

const DEBUG_LOG = '/tmp/wrtcommander-debug.log';
const DEBUG_LOG_MAX = 262144;

/* ------------------------------------------------------------------ */
/* configuration                                                       */
/* ------------------------------------------------------------------ */

function get_config() {
	let ctx = uci.cursor();
	let enabled = ctx.get('wrtcommander', 'main', 'enabled');
	let root = ctx.get('wrtcommander', 'main', 'allowed_root');
	let show_hidden = ctx.get('wrtcommander', 'main', 'show_hidden');
	let preview = ctx.get('wrtcommander', 'main', 'preview_max_size');
	let editor = ctx.get('wrtcommander', 'main', 'editor_max_size');
	let results = ctx.get('wrtcommander', 'main', 'search_max_results');
	let depth = ctx.get('wrtcommander', 'main', 'search_max_depth');
	let scanned = ctx.get('wrtcommander', 'main', 'search_max_scanned');
	let dsentries = ctx.get('wrtcommander', 'main', 'dirsize_max_entries');
	let dsdepth = ctx.get('wrtcommander', 'main', 'dirsize_max_depth');
	let debug = ctx.get('wrtcommander', 'main', 'debug');

	let root_norm = (root && root != '') ? root : '/';
	if (length(root_norm) > 1 && substr(root_norm, -1) == '/')
		root_norm = substr(root_norm, 0, length(root_norm) - 1);

	return {
		enabled: (enabled == null) ? true : (enabled == '1'),
		allowed_root: root_norm,
		show_hidden: (show_hidden == null) ? true : (show_hidden == '1'),
		preview_max_size: preview ? int(preview) : 524288,
		editor_max_size: editor ? int(editor) : 1048576,
		search_max_results: results ? int(results) : 500,
		search_max_depth: depth ? int(depth) : 12,
		search_max_scanned: scanned ? int(scanned) : 20000,
		dirsize_max_entries: dsentries ? int(dsentries) : 50000,
		dirsize_max_depth: dsdepth ? int(dsdepth) : 24,
		debug: (debug == '1'),
	};
}

/* ------------------------------------------------------------------ */
/* error helpers                                                       */
/* ------------------------------------------------------------------ */

const ERRNO_MAP = [
	['Permission denied', 'EACCES'],
	['No such file or directory', 'ENOENT'],
	['File exists', 'EEXIST'],
	['Directory not empty', 'ENOTEMPTY'],
	['No space left on device', 'ENOSPC'],
	['Read-only file system', 'EROFS'],
	['Is a directory', 'EISDIR'],
	['Not a directory', 'ENOTDIR'],
	['Invalid cross-device link', 'EXDEV'],
	['Too many open files', 'EMFILE'],
	['Name too long', 'ENAMETOOLONG'],
	['Input/output error', 'EIO'],
	['Device or resource busy', 'EBUSY'],
	['Operation not permitted', 'EPERM'],
	['Bad file descriptor', 'EBADF'],
];

function errno_from_message(msg) {
	if (!msg)
		return 'EIO';
	for (let pair in ERRNO_MAP)
		if (index(msg, pair[0]) >= 0)
			return pair[1];
	return 'EIO';
}

function make_error(code, message) {
	return { code: code, message: message };
}

function fail(code, message) {
	return { ok: false, error: make_error(code, message) };
}

function fail_from_fs(context) {
	let msg = fs.error();
	let code = errno_from_message(msg);
	let message = msg ? sprintf('%s: %s', context, msg) : context;
	return fail(code, message);
}

/* ------------------------------------------------------------------ */
/* debug logging - never logs file content, credentials or paths'      */
/* contents, only method/path/duration/result                         */
/* ------------------------------------------------------------------ */

function dbg(cfg, method, path, t0, ok, extra) {
	if (!cfg.debug)
		return;
	let dur = time() - t0;
	let line = sprintf('%d method=%s path=%s ok=%s dur=%ds%s\n',
		time(), method, path, ok ? '1' : '0', dur, extra ? (' ' + extra) : '');
	let st = fs.stat(DEBUG_LOG);
	if (st && st.size > DEBUG_LOG_MAX)
		fs.unlink(DEBUG_LOG);
	let fh = fs.open(DEBUG_LOG, 'a');
	if (fh) {
		fh.write(line);
		fh.close();
	}
}

/* ------------------------------------------------------------------ */
/* path helpers                                                        */
/* ------------------------------------------------------------------ */

function join_path(dir, name) {
	if (dir == '/')
		return '/' + name;
	return dir + '/' + name;
}

function in_root(p, root) {
	if (root == '/')
		return true;
	if (p == root)
		return true;
	return substr(p + '/', 0, length(root) + 1) == (root + '/');
}

/*
 * Canonical path validation layer. Every RPC method that touches the
 * filesystem calls this first and only ever operates on the returned
 * .path value, never on the raw client-supplied string.
 *
 * opts:
 *   must_exist   - path must already exist (default true)
 *   must_be_dir  - path must be (or resolve to) a directory
 *   no_root      - refuse to return exactly the allowed_root itself
 */
function canon(rawpath, opts) {
	opts = opts || {};
	let must_exist = exists(opts, 'must_exist') ? opts.must_exist : true;

	/* The three rejections below carry distinct messages on purpose: when
	   one of them shows up in the UI it should say which rule fired,
	   rather than leaving "Invalid path" to stand for any of them. */
	if (type(rawpath) != 'string')
		return { err: fail('EINVAL', 'Path is not a string') };
	if (rawpath == '')
		return { err: fail('EINVAL', 'Path is empty') };
	/* NUL check by index(), not by a regex. ucode's regex literals do not
	   give you a NUL matcher here: /\x00/ compiles to a pattern that
	   matches the empty string, so `match(anything, /\x00/)` is truthy for
	   every string and this rejected every path outright. index() against
	   chr(0) is exact - it returns the byte offset, or -1. */
	if (index(rawpath, chr(0)) >= 0)
		return { err: fail('EINVAL', 'Path contains a NUL byte') };
	if (substr(rawpath, 0, 1) != '/')
		return { err: fail('EINVAL', 'Path must be absolute') };

	/* lexical normalisation: resolve "." and ".." without touching the fs */
	let parts = split(rawpath, '/');
	let stack = [];
	for (let p in parts) {
		if (p == '' || p == '.')
			continue;
		if (p == '..') {
			if (length(stack) > 0)
				pop(stack);
			continue;
		}
		push(stack, p);
	}
	let normalized = '/' + join('/', stack);

	let cfg = get_config();
	let root = cfg.allowed_root;

	if (!in_root(normalized, root))
		return { err: fail('EACCES', 'Path is outside the allowed root') };

	/* symlink resolution */
	let real;
	if (fs.access(normalized, 'f')) {
		real = fs.realpath(normalized);
		if (real == null)
			return { err: fail_from_fs('Failed to resolve path') };
	} else {
		if (must_exist)
			return { err: fail('ENOENT', 'No such file or directory') };
		let parent = fs.dirname(normalized);
		if (!fs.access(parent, 'f'))
			return { err: fail('ENOENT', 'Parent directory does not exist') };
		let realparent = fs.realpath(parent);
		if (realparent == null)
			return { err: fail_from_fs('Failed to resolve parent path') };
		if (length(realparent) > 1 && substr(realparent, -1) == '/')
			realparent = substr(realparent, 0, length(realparent) - 1);
		real = join_path(realparent, fs.basename(normalized));
	}

	if (!in_root(real, root))
		return { err: fail('EACCES', 'Path escapes the allowed root via a symlink') };

	if (opts.no_root && real == root)
		return { err: fail('EACCES', 'Operation not permitted on the root directory') };

	if (opts.must_be_dir) {
		let st = fs.stat(real);
		if (!st || st.type != 'directory')
			return { err: fail('ENOTDIR', 'Not a directory') };
	}

	return { path: real };
}

/* ------------------------------------------------------------------ */
/* user / group name lookup (best effort, cached per process)          */
/* ------------------------------------------------------------------ */

let PASSWD_CACHE = null;
let GROUP_CACHE = null;

function parse_id_file(path) {
	let map = {};
	let content = fs.readfile(path);
	if (!content)
		return map;
	let lines = split(content, '\n');
	for (let line in lines) {
		if (line == '')
			continue;
		let f = split(line, ':');
		if (length(f) < 3)
			continue;
		map[int(f[2])] = f[0];
	}
	return map;
}

function uid_name(uid) {
	if (PASSWD_CACHE == null)
		PASSWD_CACHE = parse_id_file('/etc/passwd');
	let n = PASSWD_CACHE[uid];
	return (n != null) ? n : ('' + uid);
}

function gid_name(gid) {
	if (GROUP_CACHE == null)
		GROUP_CACHE = parse_id_file('/etc/group');
	let n = GROUP_CACHE[gid];
	return (n != null) ? n : ('' + gid);
}

/* ------------------------------------------------------------------ */
/* stat / permission formatting                                        */
/* ------------------------------------------------------------------ */

function perm_to_int(p) {
	let n = 0;
	if (p.setuid) n += 4096;
	if (p.setgid) n += 2048;
	if (p.sticky) n += 1024;
	if (p.user_read) n += 256;
	if (p.user_write) n += 128;
	if (p.user_exec) n += 64;
	if (p.group_read) n += 32;
	if (p.group_write) n += 16;
	if (p.group_exec) n += 8;
	if (p.other_read) n += 4;
	if (p.other_write) n += 2;
	if (p.other_exec) n += 1;
	return n;
}

function type_char(t) {
	if (t == 'file') return '-';
	if (t == 'directory') return 'd';
	if (t == 'link') return 'l';
	if (t == 'char') return 'c';
	if (t == 'block') return 'b';
	if (t == 'fifo') return 'p';
	if (t == 'socket') return 's';
	return '?';
}

function mode_string(t, p) {
	let s = type_char(t);
	s += p.user_read ? 'r' : '-';
	s += p.user_write ? 'w' : '-';
	s += p.setuid ? (p.user_exec ? 's' : 'S') : (p.user_exec ? 'x' : '-');
	s += p.group_read ? 'r' : '-';
	s += p.group_write ? 'w' : '-';
	s += p.setgid ? (p.group_exec ? 's' : 'S') : (p.group_exec ? 'x' : '-');
	s += p.other_read ? 'r' : '-';
	s += p.other_write ? 'w' : '-';
	s += p.sticky ? (p.other_exec ? 't' : 'T') : (p.other_exec ? 'x' : '-');
	return s;
}

function build_entry(fullpath, name) {
	let lst = fs.lstat(fullpath);
	if (!lst)
		return null;

	let entry = {
		name: name,
		path: fullpath,
		type: lst.type,
		size: lst.size,
		mtime: lst.mtime,
		atime: lst.atime,
		ctime: lst.ctime,
		uid: lst.uid,
		gid: lst.gid,
		owner: uid_name(lst.uid),
		group: gid_name(lst.gid),
		mode_octal: sprintf('%04o', perm_to_int(lst.perm)),
		mode_string: mode_string(lst.type, lst.perm),
		is_symlink: (lst.type == 'link'),
		hidden: (substr(name, 0, 1) == '.'),
		broken: false,
	};

	if (lst.type == 'link') {
		entry.symlink_target = fs.readlink(fullpath);
		let tst = fs.stat(fullpath);
		if (tst) {
			entry.target_type = tst.type;
			entry.target_size = tst.size;
		} else {
			entry.broken = true;
		}
	}

	return entry;
}

/* ------------------------------------------------------------------ */
/* binary detection (NUL-byte heuristic, same class used by git)       */
/* ------------------------------------------------------------------ */

function detect_binary(data) {
	if (!data)
		return false;
	let sample = (length(data) > 8000) ? substr(data, 0, 8000) : data;
	/* same reason as canon(): a regex literal will not find a NUL here,
	   and with /\x00/ this reported every file as binary */
	return index(sample, chr(0)) >= 0;
}

/* ------------------------------------------------------------------ */
/* recursive remove / copy                                             */
/* ------------------------------------------------------------------ */

function remove_one(path) {
	let lst = fs.lstat(path);
	if (!lst)
		return fail_from_fs('Cannot stat').error;

	if (lst.type == 'directory') {
		let dh = fs.opendir(path);
		if (!dh)
			return fail_from_fs('Cannot open directory').error;
		for (;;) {
			let name = dh.read();
			if (name == null || name == false)
				break;
			if (name == '.' || name == '..')
				continue;
			let r = remove_one(join_path(path, name));
			if (type(r) == 'object') {
				dh.close();
				return r;
			}
		}
		dh.close();
		if (!fs.rmdir(path))
			return fail_from_fs('Cannot remove directory').error;
		return true;
	}

	if (!fs.unlink(path))
		return fail_from_fs('Cannot remove file').error;
	return true;
}

function copy_one(src, dst) {
	let lst = fs.lstat(src);
	if (!lst)
		return fail_from_fs('Cannot stat source').error;

	if (lst.type == 'link') {
		let target = fs.readlink(src);
		if (target == null)
			return fail_from_fs('Cannot read symlink').error;
		if (!fs.symlink(target, dst))
			return fail_from_fs('Cannot create symlink').error;
		return true;
	}

	if (lst.type == 'directory') {
		if (!fs.mkdir(dst, perm_to_int(lst.perm)))
			return fail_from_fs('Cannot create directory').error;
		let dh = fs.opendir(src);
		if (!dh)
			return fail_from_fs('Cannot open source directory').error;
		for (;;) {
			let name = dh.read();
			if (name == null || name == false)
				break;
			if (name == '.' || name == '..')
				continue;
			let r = copy_one(join_path(src, name), join_path(dst, name));
			if (type(r) == 'object') {
				dh.close();
				return r;
			}
		}
		dh.close();
		return true;
	}

	if (lst.type == 'file') {
		let sfh = fs.open(src, 'r');
		if (!sfh)
			return fail_from_fs('Cannot open source file').error;
		let dfh = fs.open(dst, 'wx', perm_to_int(lst.perm));
		if (!dfh) {
			sfh.close();
			return fail_from_fs('Cannot create destination file').error;
		}
		const CHUNK = 65536;
		for (;;) {
			let buf = sfh.read(CHUNK);
			if (buf == null || buf == '')
				break;
			let w = dfh.write(buf);
			if (w == null || w != length(buf)) {
				sfh.close();
				dfh.close();
				fs.unlink(dst);
				return fail_from_fs('Write failed (disk full or I/O error)').error;
			}
			if (length(buf) < CHUNK)
				break;
		}
		sfh.close();
		dfh.close();
		return true;
	}

	/* fifo / socket / device: never silently "succeed" on these */
	return make_error('EINVAL', 'Cannot copy special file: ' + src);
}

/* ------------------------------------------------------------------ */
/* recursive search                                                     */
/* ------------------------------------------------------------------ */

function search_walk(dir, needle, recursive, max_depth, depth, max_results, max_scanned, results, scanned, truncated) {
	if (length(results) >= max_results || scanned.n >= max_scanned) {
		truncated.v = true;
		return;
	}
	let dh = fs.opendir(dir);
	if (!dh)
		return;
	for (;;) {
		if (length(results) >= max_results || scanned.n >= max_scanned) {
			truncated.v = true;
			break;
		}
		let name = dh.read();
		if (name == null || name == false)
			break;
		if (name == '.' || name == '..')
			continue;
		scanned.n++;
		let full = join_path(dir, name);
		if (index(lc(name), needle) >= 0) {
			let e = build_entry(full, name);
			if (e)
				push(results, e);
		}
		if (recursive && depth < max_depth) {
			let lst = fs.lstat(full);
			if (lst && lst.type == 'directory')
				search_walk(full, needle, recursive, max_depth, depth + 1, max_results, max_scanned, results, scanned, truncated);
		}
	}
	dh.close();
}

/* Sum the apparent size of everything under `dir`.
 *
 * Three deliberate limits, because this runs on a router:
 *
 *   - lstat, never stat, so a symlink is counted as a link and never
 *     followed. That rules out symlink loops and any escape from the
 *     allowed root partway down the tree.
 *   - directories on a different device are not descended into, the way
 *     `du -x` behaves. Starting at / this keeps the walk out of /proc
 *     and /sys, whose sizes are fictional and some of whose files block
 *     when read, and stops "size of /" from silently including a mounted
 *     USB disk. Asking for the size of the mount point itself still
 *     works, because then that device is the one we start on.
 *   - a hard cap on entries visited and on depth. Reaching either stops
 *     the walk and sets truncated, so the caller can say the number is a
 *     lower bound instead of quietly reporting a wrong total.
 *
 * An unreadable subdirectory is skipped rather than failing the whole
 * walk - a non-root session will hit those, and a partial total with
 * truncated set is more useful than an error.
 *
 * Apparent size, not blocks used: it has to be consistent with the size
 * column for files, which is st.size. Hard links are therefore counted
 * once per link rather than once per inode. */
/* fs.lstat() reports the device as an object, { major, minor }, not as a
   number - so comparing two of them with != compares object identity and
   is always true. Getting this wrong is silent: every subdirectory looks
   like a different filesystem, the walk never descends, and the reported
   size is just the files in the top level. */
function same_dev(a, b) {
	if (a == null || b == null)
		return true;
	return (a.major == b.major && a.minor == b.minor);
}

function dirsize_walk(dir, depth, cap, total) {
	if (cap.entries >= cap.max_entries || depth > cap.max_depth) {
		cap.truncated = true;
		return;
	}
	let dh = fs.opendir(dir);
	if (!dh) {
		cap.unreadable++;
		return;
	}
	for (;;) {
		if (cap.entries >= cap.max_entries) {
			cap.truncated = true;
			break;
		}
		let name = dh.read();
		if (name == null || name == false)
			break;
		if (name == '.' || name == '..')
			continue;
		cap.entries++;
		let st = fs.lstat(join_path(dir, name));
		if (!st)
			continue;
		if (st.type == 'directory') {
			/* cap.dev is null when the platform did not report a device
			   number; then the caps are the only limit */
			if (!same_dev(cap.dev, st.dev)) {
				cap.crossed++;
				continue;
			}
			total.dirs++;
			dirsize_walk(join_path(dir, name), depth + 1, cap, total);
		}
		else if (st.type == 'file') {
			total.files++;
			total.bytes += st.size;
		}
		/* links, sockets, fifos and device nodes occupy no data blocks
		   of their own, so they add nothing to the total */
	}
	dh.close();
}

/* ------------------------------------------------------------------ */
/* mount / disk info                                                    */
/* ------------------------------------------------------------------ */

function find_mount(path) {
	let content = fs.readfile('/proc/mounts');
	let best_mp = '/', best_fstype = 'unknown', best_dev = '', found = false;
	if (!content)
		return { mountpoint: best_mp, fstype: best_fstype, device: best_dev };
	let lines = split(content, '\n');
	for (let line in lines) {
		if (line == '')
			continue;
		let f = split(line, ' ');
		if (length(f) < 3)
			continue;
		let mp = f[1];
		let matches = (mp == '/') || (path == mp) || (substr(path + '/', 0, length(mp) + 1) == (mp + '/'));
		if (matches && (!found || length(mp) > length(best_mp))) {
			best_mp = mp;
			best_fstype = f[2];
			best_dev = f[0];
			found = true;
		}
	}
	return { mountpoint: best_mp, fstype: best_fstype, device: best_dev };
}

/* ------------------------------------------------------------------ */
/* misc                                                                  */
/* ------------------------------------------------------------------ */

let TMP_COUNTER = 0;

function tmp_suffix() {
	TMP_COUNTER++;
	return sprintf('%d-%d-%d', time(), TMP_COUNTER, math.rand());
}

/* ------------------------------------------------------------------ */
/* ubus object                                                          */
/* ------------------------------------------------------------------ */

return {
	'luci.wrtcommander': {

		list: {
			args: { path: '/', show_hidden: true },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				let show_hidden = (a.show_hidden != null) ? a.show_hidden : cfg.show_hidden;
				let c = canon(a.path, { must_exist: true, must_be_dir: true });
				if (c.err)
					return c.err;
				let dh = fs.opendir(c.path);
				if (!dh)
					return fail_from_fs('Cannot open directory');
				let entries = [];
				for (;;) {
					let name = dh.read();
					if (name == null || name == false)
						break;
					if (name == '.' || name == '..')
						continue;
					if (!show_hidden && substr(name, 0, 1) == '.')
						continue;
					let e = build_entry(join_path(c.path, name), name);
					if (e)
						push(entries, e);
				}
				dh.close();
				let parent = (c.path == cfg.allowed_root) ? null : fs.dirname(c.path);
				dbg(cfg, 'list', c.path, t0, true, null);
				return { ok: true, path: c.path, parent: parent, allowed_root: cfg.allowed_root, entries: entries };
			}
		},

		stat: {
			args: { path: '/' },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let c = canon(req.args.path, { must_exist: true });
				if (c.err)
					return c.err;
				let e = build_entry(c.path, fs.basename(c.path));
				if (!e)
					return fail_from_fs('Cannot stat path');
				let mount = find_mount(c.path);
				e.ok = true;
				e.mount = mount.mountpoint;
				e.fstype = mount.fstype;
				return e;
			}
		},

		read: {
			args: { path: '/', mode: 'preview' },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				let mode = a.mode || 'preview';
				let c = canon(a.path, { must_exist: true });
				if (c.err)
					return c.err;

				let st = fs.stat(c.path);
				if (!st)
					return fail_from_fs('Cannot stat file');
				if (st.type == 'directory')
					return fail('EISDIR', 'Is a directory');
				if (st.type != 'file')
					return fail('EINVAL', 'Not a regular file');

				let limit = (mode == 'edit') ? cfg.editor_max_size : cfg.preview_max_size;
				let size = st.size;

				if ((mode == 'preview' || mode == 'edit') && size > limit)
					return fail('EFBIG', sprintf('File is too large for %s (%d bytes, limit %d bytes)', mode, size, limit));

				let fh = fs.open(c.path, 'r');
				if (!fh)
					return fail_from_fs('Cannot open file');

				let data, truncated = false;
				if (mode == 'tail') {
					let start = (size > limit) ? (size - limit) : 0;
					fh.seek(start, 0);
					data = fh.read(limit + 1);
					truncated = (start > 0);
				} else {
					data = fh.read(limit + 1);
					if (length(data) > limit) {
						data = substr(data, 0, limit);
						truncated = true;
					}
				}
				fh.close();

				let is_binary = detect_binary(data);
				if (mode == 'edit' && is_binary)
					return fail('EINVAL', 'Not a text file');

				dbg(cfg, 'read', c.path, t0, true, 'mode=' + mode);
				return {
					ok: true,
					path: c.path,
					size: size,
					mtime: st.mtime,
					is_binary: is_binary,
					truncated: truncated,
					encoding: 'base64',
					data: b64enc(data),
				};
			}
		},

		write: {
			args: { path: '/', data: '', encoding: 'base64', expected_mtime: 0, expected_size: 0, force: false },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				let c = canon(a.path, { must_exist: false });
				if (c.err)
					return c.err;

				let raw = (a.encoding == 'base64') ? b64dec(a.data) : a.data;
				if (raw == null)
					return fail('EINVAL', 'Invalid data encoding');
				if (length(raw) > cfg.editor_max_size)
					return fail('EFBIG', sprintf('Content exceeds the editor size limit (%d bytes)', cfg.editor_max_size));

				let existing = fs.stat(c.path);
				if (existing) {
					if (existing.type == 'directory')
						return fail('EISDIR', 'Is a directory');
					if (!a.force && a.expected_mtime && (existing.mtime != a.expected_mtime || existing.size != a.expected_size))
						return fail('ECONFLICT', 'File has been modified externally');
				}

				let tmp = c.path + '.' + tmp_suffix() + '.tmp';
				let fh = fs.open(tmp, 'wx', existing ? perm_to_int(existing.perm) : 420);
				if (!fh)
					return fail_from_fs('Cannot create temporary file');
				let written = fh.write(raw);
				fh.close();
				if (written == null || written != length(raw)) {
					fs.unlink(tmp);
					return fail_from_fs('Write failed (disk full or I/O error)');
				}
				if (existing) {
					fs.chmod(tmp, perm_to_int(existing.perm));
					fs.chown(tmp, existing.uid, existing.gid);
				}
				if (!fs.rename(tmp, c.path)) {
					let e = fail_from_fs('Cannot save file');
					fs.unlink(tmp);
					return e;
				}
				let st = fs.stat(c.path);
				dbg(cfg, 'write', c.path, t0, true, null);
				return { ok: true, path: c.path, size: st.size, mtime: st.mtime };
			}
		},

		mkdir: {
			args: { path: '/' },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let c = canon(req.args.path, { must_exist: false });
				if (c.err)
					return c.err;
				if (fs.access(c.path, 'f'))
					return fail('EEXIST', 'Already exists');
				if (!fs.mkdir(c.path, 493))
					return fail_from_fs('Cannot create directory');
				return { ok: true, path: c.path };
			}
		},

		create: {
			args: { path: '/' },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let c = canon(req.args.path, { must_exist: false });
				if (c.err)
					return c.err;
				let fh = fs.open(c.path, 'wx', 420);
				if (!fh)
					return fail_from_fs('Cannot create file');
				fh.close();
				return { ok: true, path: c.path };
			}
		},

		rename: {
			args: { path: '/', name: '' },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				if (type(a.name) != 'string' || a.name == '' || index(a.name, '/') >= 0 || a.name == '.' || a.name == '..')
					return fail('EINVAL', 'Invalid name');
				let c = canon(a.path, { must_exist: true, no_root: true });
				if (c.err)
					return c.err;
				let target = join_path(fs.dirname(c.path), a.name);
				let tc = canon(target, { must_exist: false });
				if (tc.err)
					return tc.err;
				if (fs.access(tc.path, 'f'))
					return fail('EEXIST', 'Target already exists');
				if (!fs.rename(c.path, tc.path))
					return fail_from_fs('Cannot rename');
				return { ok: true, path: tc.path };
			}
		},

		remove: {
			args: { paths: [''] },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let paths = req.args.paths;
				if (type(paths) != 'array' || length(paths) == 0)
					return fail('EINVAL', 'No paths given');
				let results = [];
				for (let p in paths) {
					let c = canon(p, { must_exist: true, no_root: true });
					if (c.err) {
						push(results, { path: p, ok: false, error: c.err.error });
						continue;
					}
					let r = remove_one(c.path);
					push(results, { path: c.path, ok: (r === true), error: (r === true) ? null : r });
				}
				dbg(cfg, 'remove', join('; ', paths), t0, true, null);
				return { ok: true, results: results };
			}
		},

		copy: {
			args: { items: [''], destination: '/', overwrite: false },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				if (type(a.items) != 'array' || length(a.items) == 0)
					return fail('EINVAL', 'No items given');
				let dc = canon(a.destination, { must_exist: true, must_be_dir: true });
				if (dc.err)
					return dc.err;
				let results = [];
				for (let src in a.items) {
					let sc = canon(src, { must_exist: true });
					if (sc.err) {
						push(results, { path: src, ok: false, error: sc.err.error });
						continue;
					}
					let name = fs.basename(sc.path);
					let target = join_path(dc.path, name);

					if (target == sc.path) {
						push(results, { path: src, ok: false, error: make_error('EINVAL', 'Source and destination are the same') });
						continue;
					}
					if (dc.path == sc.path || substr(dc.path + '/', 0, length(sc.path) + 1) == (sc.path + '/')) {
						push(results, { path: src, ok: false, error: make_error('EINVAL', 'Cannot copy a directory into itself') });
						continue;
					}
					if (fs.access(target, 'f')) {
						if (!a.overwrite) {
							push(results, { path: src, ok: false, error: make_error('EEXIST', 'Already exists in destination') });
							continue;
						}
						let rr = remove_one(target);
						if (type(rr) == 'object') {
							push(results, { path: src, ok: false, error: rr });
							continue;
						}
					}
					let r = copy_one(sc.path, target);
					push(results, { path: src, ok: (r === true), error: (r === true) ? null : r, target: target });
				}
				dbg(cfg, 'copy', dc.path, t0, true, null);
				return { ok: true, results: results };
			}
		},

		move: {
			args: { items: [''], destination: '/', overwrite: false },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				if (type(a.items) != 'array' || length(a.items) == 0)
					return fail('EINVAL', 'No items given');
				let dc = canon(a.destination, { must_exist: true, must_be_dir: true });
				if (dc.err)
					return dc.err;
				let results = [];
				for (let src in a.items) {
					let sc = canon(src, { must_exist: true, no_root: true });
					if (sc.err) {
						push(results, { path: src, ok: false, error: sc.err.error });
						continue;
					}
					let name = fs.basename(sc.path);
					let target = join_path(dc.path, name);

					if (target == sc.path) {
						push(results, { path: src, ok: false, error: make_error('EINVAL', 'Source and destination are the same') });
						continue;
					}
					if (dc.path == sc.path || substr(dc.path + '/', 0, length(sc.path) + 1) == (sc.path + '/')) {
						push(results, { path: src, ok: false, error: make_error('EINVAL', 'Cannot move a directory into itself') });
						continue;
					}
					if (fs.access(target, 'f')) {
						if (!a.overwrite) {
							push(results, { path: src, ok: false, error: make_error('EEXIST', 'Already exists in destination') });
							continue;
						}
						let rr = remove_one(target);
						if (type(rr) == 'object') {
							push(results, { path: src, ok: false, error: rr });
							continue;
						}
					}
					if (fs.rename(sc.path, target)) {
						push(results, { path: src, ok: true, target: target });
						continue;
					}
					/* cross-device or other rename failure: fall back to copy + delete */
					let cr = copy_one(sc.path, target);
					if (type(cr) == 'object') {
						push(results, { path: src, ok: false, error: cr });
						continue;
					}
					let rr2 = remove_one(sc.path);
					if (type(rr2) == 'object') {
						push(results, { path: src, ok: false, error: make_error('EIO', 'Copied but failed to remove source: ' + rr2.message) });
						continue;
					}
					push(results, { path: src, ok: true, target: target });
				}
				dbg(cfg, 'move', dc.path, t0, true, null);
				return { ok: true, results: results };
			}
		},

		chmod: {
			args: { path: '/', mode: 420 },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				let c = canon(a.path, { must_exist: true });
				if (c.err)
					return c.err;
				let mode = int(a.mode);
				if (mode == null || mode < 0 || mode > 4095)
					return fail('EINVAL', 'Invalid mode');
				if (!fs.chmod(c.path, mode))
					return fail_from_fs('Cannot change permissions');
				return { ok: true, path: c.path, mode_octal: sprintf('%04o', mode) };
			}
		},

		chown: {
			args: { path: '/', uid: -1, gid: -1 },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				let c = canon(a.path, { must_exist: true });
				if (c.err)
					return c.err;
				let uid = (a.uid == null || a.uid < 0) ? null : int(a.uid);
				let gid = (a.gid == null || a.gid < 0) ? null : int(a.gid);
				if (uid == null && gid == null)
					return fail('EINVAL', 'No uid/gid given');
				if (!fs.chown(c.path, uid, gid))
					return fail_from_fs('Cannot change owner');
				return { ok: true, path: c.path };
			}
		},

		search: {
			args: { path: '/', query: '', recursive: false, max_results: 500 },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let a = req.args;
				if (type(a.query) != 'string' || a.query == '')
					return fail('EINVAL', 'Empty query');
				let c = canon(a.path, { must_exist: true, must_be_dir: true });
				if (c.err)
					return c.err;

				let max_results = a.max_results ? int(a.max_results) : cfg.search_max_results;
				if (max_results > cfg.search_max_results)
					max_results = cfg.search_max_results;

				let needle = lc(a.query);
				let results = [];
				let scanned = { n: 0 };
				let truncated = { v: false };

				search_walk(c.path, needle, a.recursive, cfg.search_max_depth, 0, max_results, cfg.search_max_scanned, results, scanned, truncated);

				dbg(cfg, 'search', c.path, t0, true, sprintf('scanned=%d results=%d', scanned.n, length(results)));
				return { ok: true, results: results, truncated: truncated.v, scanned: scanned.n };
			}
		},

		/* On-demand only. Never called while building a listing: a
		   directory's size is the sum of its whole subtree, so filling
		   the column for every row would walk the entire filesystem
		   once per visible folder. */
		dirsize: {
			args: { path: '/' },
			call: function(req) {
				let t0 = time();
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let c = canon(req.args.path, { must_exist: true, must_be_dir: true });
				if (c.err)
					return c.err;

				let start = fs.lstat(c.path);
				let cap = {
					entries: 0,
					max_entries: cfg.dirsize_max_entries,
					max_depth: cfg.dirsize_max_depth,
					dev: (start && start.dev != null) ? start.dev : null,
					truncated: false,
					crossed: 0,
					unreadable: 0
				};
				let total = { bytes: 0, files: 0, dirs: 0 };

				dirsize_walk(c.path, 0, cap, total);

				dbg(cfg, 'dirsize', c.path, t0, true,
					sprintf('bytes=%d files=%d dirs=%d scanned=%d truncated=%d',
						total.bytes, total.files, total.dirs, cap.entries, cap.truncated ? 1 : 0));

				return {
					ok: true,
					path: c.path,
					size: total.bytes,
					files: total.files,
					dirs: total.dirs,
					scanned: cap.entries,
					/* the total is a lower bound when any of these is set */
					truncated: cap.truncated,
					crossed_mounts: cap.crossed,
					unreadable: cap.unreadable
				};
			}
		},

		disk_info: {
			args: { path: '/' },
			call: function(req) {
				let cfg = get_config();
				if (!cfg.enabled)
					return fail('EACCES', 'Wrt Commander is disabled');
				let c = canon(req.args.path, { must_exist: true });
				if (c.err)
					return c.err;

				let mount = find_mount(c.path);
				let proc = fs.popen(['df', '-kP', c.path], 'r');
				if (!proc)
					return fail('EIO', 'Cannot run df');
				let out = proc.read('all');
				proc.close();
				if (!out)
					return fail('EIO', 'No output from df');

				let lines = split(trim(out), '\n');
				if (length(lines) < 2)
					return fail('EIO', 'Unexpected df output');
				let fields = split(trim(lines[length(lines) - 1]), /\s+/);
				if (length(fields) < 6)
					return fail('EIO', 'Unexpected df output');

				let total_k = int(fields[1]);
				let used_k = int(fields[2]);
				let avail_k = int(fields[3]);

				return {
					ok: true,
					path: c.path,
					filesystem: fields[0],
					mountpoint: mount.mountpoint,
					fstype: mount.fstype,
					total: total_k * 1024,
					used: used_k * 1024,
					free: avail_k * 1024,
				};
			}
		},

	}
};
