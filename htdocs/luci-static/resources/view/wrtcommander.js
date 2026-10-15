'use strict';
'require view';
'require rpc';
'require ui';
'require dom';

/* ==================================================================
 * Wrt Commander - LuCI JS view (two-pane commander)
 *
 * Talks to the "luci.wrtcommander" ubus object for every filesystem
 * operation (see /usr/share/rpcd/ucode/wrtcommander.uc) and to two
 * plain HTTP endpoints on the Lua controller for streaming upload
 * and download (see /usr/lib/lua/luci/controller/wrtcommander.lua).
 *
 * The backend is the sole security boundary: every call below is a
 * convenience for the user, never the reason an operation is allowed.
 * Hiding a button here is UX, not access control.
 *
 * All user-visible strings go through _() / N_() so they can be
 * translated from po/*.po (see po/README.md).
 * ================================================================ */

var callList = rpc.declare({ object: 'luci.wrtcommander', method: 'list', params: ['path', 'show_hidden'] });
var callStat = rpc.declare({ object: 'luci.wrtcommander', method: 'stat', params: ['path'] });
var callRead = rpc.declare({ object: 'luci.wrtcommander', method: 'read', params: ['path', 'mode'] });
var callWrite = rpc.declare({ object: 'luci.wrtcommander', method: 'write', params: ['path', 'data', 'encoding', 'expected_mtime', 'expected_size', 'force'] });
var callMkdir = rpc.declare({ object: 'luci.wrtcommander', method: 'mkdir', params: ['path'] });
var callCreate = rpc.declare({ object: 'luci.wrtcommander', method: 'create', params: ['path'] });
var callRename = rpc.declare({ object: 'luci.wrtcommander', method: 'rename', params: ['path', 'name'] });
var callRemove = rpc.declare({ object: 'luci.wrtcommander', method: 'remove', params: ['paths'] });
var callCopy = rpc.declare({ object: 'luci.wrtcommander', method: 'copy', params: ['items', 'destination', 'overwrite'] });
var callMove = rpc.declare({ object: 'luci.wrtcommander', method: 'move', params: ['items', 'destination', 'overwrite'] });
var callChmod = rpc.declare({ object: 'luci.wrtcommander', method: 'chmod', params: ['path', 'mode'] });
var callChown = rpc.declare({ object: 'luci.wrtcommander', method: 'chown', params: ['path', 'uid', 'gid'] });
var callSearch = rpc.declare({ object: 'luci.wrtcommander', method: 'search', params: ['path', 'query', 'recursive', 'max_results'] });
var callDiskInfo = rpc.declare({ object: 'luci.wrtcommander', method: 'disk_info', params: ['path'] });
var callDirSize = rpc.declare({ object: 'luci.wrtcommander', method: 'dirsize', params: ['path'] });

var LS_PREFIX = 'wrtcommander.';

/* ------------------------------------------------------------------
 * small utilities
 * ------------------------------------------------------------------ */

/* The three fixed-width columns, with the CSS variable each one drives
   and the range a drag is allowed to move it through. The minimums are
   what the shortest real value still needs ("42 B", "-rw-r--r--"); the
   maximums only exist so a stray drag cannot squeeze the name column
   down to nothing. */
var COLUMNS = {
	size: { prop: '--fx-w-size', min: 56,  max: 260 },
	time: { prop: '--fx-w-time', min: 70,  max: 340 },
	perm: { prop: '--fx-w-perm', min: 56,  max: 260 }
};

function lsGet(key, def) {
	try {
		var v = window.localStorage.getItem(LS_PREFIX + key);
		return (v === null) ? def : JSON.parse(v);
	} catch (e) {
		return def;
	}
}

function lsSet(key, val) {
	try {
		window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(val));
	} catch (e) { /* ignore quota / privacy-mode errors */ }
}

function fmtSize(n) {
	if (n === null || n === undefined)
		return '—';
	if (n < 1024)
		return _('%d B', 'wrtcommander').format(n);
	var v = n / 1024;
	if (v < 1024)
		return _('%s KiB', 'wrtcommander').format(v.toFixed(v < 10 ? 1 : 0));
	v = v / 1024;
	if (v < 1024)
		return _('%s MiB', 'wrtcommander').format(v.toFixed(v < 10 ? 2 : 1));
	v = v / 1024;
	return _('%s GiB', 'wrtcommander').format(v.toFixed(2));
}

function fmtTime(sec) {
	if (!sec)
		return '—';
	var d = new Date(sec * 1000);
	var p = function (x) { return (x < 10 ? '0' : '') + x; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
		' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function b64EncodeUtf8(str) {
	return window.btoa(unescape(encodeURIComponent(str)));
}

function b64DecodeUtf8(b64) {
	return decodeURIComponent(escape(window.atob(b64)));
}

function joinPath(dir, name) {
	if (dir === '/')
		return '/' + name;
	return dir.replace(/\/+$/, '') + '/' + name;
}

function dirName(p) {
	if (p === '/')
		return '/';
	var idx = p.lastIndexOf('/');
	return (idx <= 0) ? '/' : p.substring(0, idx);
}

var TEXT_EXT = ['txt', 'conf', 'cfg', 'ini', 'json', 'xml', 'html', 'htm', 'css', 'js', 'lua', 'uc', 'sh', 'log', 'uci', 'md', 'yml', 'yaml', 'csv', 'crontab', 'hosts'];
var IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'];
var ARCHIVE_EXT = ['tar', 'gz', 'tgz', 'bz2', 'xz', 'zip', 'ipk', 'apk', '7z', 'rar'];

function extOf(name) {
	var idx = name.lastIndexOf('.');
	return (idx <= 0) ? '' : name.substring(idx + 1).toLowerCase();
}

/* Returns a stable, untranslated type key; label it with typeLabel(). */
function classify(entry) {
	if (entry.type === 'directory') return 'directory';
	if (entry.type === 'link') return 'symlink';
	if (entry.type === 'char' || entry.type === 'block') return 'device';
	if (entry.type === 'fifo') return 'fifo';
	if (entry.type === 'socket') return 'socket';
	var ext = extOf(entry.name);
	if (IMAGE_EXT.indexOf(ext) >= 0) return 'image';
	if (ARCHIVE_EXT.indexOf(ext) >= 0) return 'archive';
	if (TEXT_EXT.indexOf(ext) >= 0) return 'text';
	if (entry.size === 0) return 'text';
	return 'binary';
}

function typeLabel(cls) {
	switch (cls) {
		case 'directory': return _('Directory', 'wrtcommander');
		case 'symlink': return _('Symlink', 'wrtcommander');
		case 'device': return _('Device', 'wrtcommander');
		case 'fifo': return _('FIFO', 'wrtcommander');
		case 'socket': return _('Socket', 'wrtcommander');
		case 'image': return _('Image', 'wrtcommander');
		case 'archive': return _('Archive', 'wrtcommander');
		case 'text': return _('Text', 'wrtcommander');
		default: return _('Binary', 'wrtcommander');
	}
}

function iconFor(entry, cls) {
	if (entry.type === 'directory') return '📁';
	if (entry.type === 'link') return entry.broken ? '⚠️' : '🔗';
	if (entry.type === 'char' || entry.type === 'block') return '🔌';
	if (entry.type === 'fifo' || entry.type === 'socket') return '🕳️';
	switch (cls) {
		case 'image': return '🖼️';
		case 'archive': return '📦';
		default: return '📄';
	}
}

/* Every failure that reaches the UI from the ucode backend or the Lua
   upload/download controller is a fixed English sentence, so it can be
   translated here. Exact matches are looked up first, then the two
   messages that carry runtime values, then "Context: detail" pairs in
   which each half is itself a known message - "Cannot open directory:
   Permission denied", or a filename after "File already exists:".
   Anything unrecognised is shown unchanged, which is also the fallback
   when a language has no translation for a message. Keep this table in
   sync with the strings in root/usr/share/rpcd/ucode/wrtcommander.uc
   and root/usr/lib/lua/luci/controller/wrtcommander.lua. */
var BACKEND_MESSAGES = {
	'Already exists': _('Already exists', 'wrtcommander'),
	'Already exists in destination': _('Already exists in destination', 'wrtcommander'),
	'Bad file descriptor': _('Bad file descriptor', 'wrtcommander'),
	'Cannot change owner': _('Cannot change owner', 'wrtcommander'),
	'Cannot change permissions': _('Cannot change permissions', 'wrtcommander'),
	'Cannot copy a directory into itself': _('Cannot copy a directory into itself', 'wrtcommander'),
	'Cannot copy special file': _('Cannot copy special file', 'wrtcommander'),
	'Cannot create destination file': _('Cannot create destination file', 'wrtcommander'),
	'Cannot create directory': _('Cannot create directory', 'wrtcommander'),
	'Cannot create file': _('Cannot create file', 'wrtcommander'),
	'Cannot create symlink': _('Cannot create symlink', 'wrtcommander'),
	'Cannot create temporary file': _('Cannot create temporary file', 'wrtcommander'),
	'Cannot download a directory': _('Cannot download a directory', 'wrtcommander'),
	'Cannot move a directory into itself': _('Cannot move a directory into itself', 'wrtcommander'),
	'Cannot open directory': _('Cannot open directory', 'wrtcommander'),
	'Cannot open file': _('Cannot open file', 'wrtcommander'),
	'Cannot open source directory': _('Cannot open source directory', 'wrtcommander'),
	'Cannot open source file': _('Cannot open source file', 'wrtcommander'),
	'Cannot read symlink': _('Cannot read symlink', 'wrtcommander'),
	'Cannot remove directory': _('Cannot remove directory', 'wrtcommander'),
	'Cannot remove file': _('Cannot remove file', 'wrtcommander'),
	'Cannot rename': _('Cannot rename', 'wrtcommander'),
	'Cannot run df': _('Cannot run df', 'wrtcommander'),
	'Cannot save file': _('Cannot save file', 'wrtcommander'),
	'Cannot stat': _('Cannot stat', 'wrtcommander'),
	'Cannot stat file': _('Cannot stat file', 'wrtcommander'),
	'Cannot stat path': _('Cannot stat path', 'wrtcommander'),
	'Cannot stat source': _('Cannot stat source', 'wrtcommander'),
	'Copied but failed to remove source': _('Copied but failed to remove source', 'wrtcommander'),
	'Destination is not a directory': _('Destination is not a directory', 'wrtcommander'),
	'Device or resource busy': _('Device or resource busy', 'wrtcommander'),
	'Directory not empty': _('Directory not empty', 'wrtcommander'),
	'Empty query': _('Empty query', 'wrtcommander'),
	'Failed to resolve parent path': _('Failed to resolve parent path', 'wrtcommander'),
	'Failed to resolve path': _('Failed to resolve path', 'wrtcommander'),
	'File already exists': _('File already exists', 'wrtcommander'),
	'File exists': _('File exists', 'wrtcommander'),
	'File has been modified externally': _('File has been modified externally', 'wrtcommander'),
	'Input/output error': _('Input/output error', 'wrtcommander'),
	'Invalid cross-device link': _('Invalid cross-device link', 'wrtcommander'),
	'Invalid data encoding': _('Invalid data encoding', 'wrtcommander'),
	'Invalid destination': _('Invalid destination', 'wrtcommander'),
	'Invalid filename': _('Invalid filename', 'wrtcommander'),
	'Invalid mode': _('Invalid mode', 'wrtcommander'),
	'Invalid name': _('Invalid name', 'wrtcommander'),
	'Invalid path': _('Invalid path', 'wrtcommander'),
	'Invalid target path': _('Invalid target path', 'wrtcommander'),
	'Is a directory': _('Is a directory', 'wrtcommander'),
	'Name too long': _('Name too long', 'wrtcommander'),
	'No file received': _('No file received', 'wrtcommander'),
	'No items given': _('No items given', 'wrtcommander'),
	'No output from df': _('No output from df', 'wrtcommander'),
	'No paths given': _('No paths given', 'wrtcommander'),
	'No space left on device': _('No space left on device', 'wrtcommander'),
	'No such file or directory': _('No such file or directory', 'wrtcommander'),
	'No uid/gid given': _('No uid/gid given', 'wrtcommander'),
	'Not a directory': _('Not a directory', 'wrtcommander'),
	'Not a regular file': _('Not a regular file', 'wrtcommander'),
	'Not a text file': _('Not a text file', 'wrtcommander'),
	'Not found': _('Not found', 'wrtcommander'),
	'Operation not permitted': _('Operation not permitted', 'wrtcommander'),
	'Operation not permitted on the root directory': _('Operation not permitted on the root directory', 'wrtcommander'),
	'Parent directory does not exist': _('Parent directory does not exist', 'wrtcommander'),
	'Path contains a NUL byte': _('Path contains a NUL byte', 'wrtcommander'),
	'Path escapes the allowed root via a symlink': _('Path escapes the allowed root via a symlink', 'wrtcommander'),
	'Path is empty': _('Path is empty', 'wrtcommander'),
	'Path is not a string': _('Path is not a string', 'wrtcommander'),
	'Path is outside the allowed root': _('Path is outside the allowed root', 'wrtcommander'),
	'Path must be absolute': _('Path must be absolute', 'wrtcommander'),
	'Permission denied': _('Permission denied', 'wrtcommander'),
	'Read-only file system': _('Read-only file system', 'wrtcommander'),
	'Refusing to download a non-regular file': _('Refusing to download a non-regular file', 'wrtcommander'),
	'Source and destination are the same': _('Source and destination are the same', 'wrtcommander'),
	'Target already exists': _('Target already exists', 'wrtcommander'),
	'Too many open files': _('Too many open files', 'wrtcommander'),
	'Unexpected df output': _('Unexpected df output', 'wrtcommander'),
	'Write failed (disk full or I/O error)': _('Write failed (disk full or I/O error)', 'wrtcommander'),
	'Wrt Commander is disabled': _('Wrt Commander is disabled', 'wrtcommander')
};

var BACKEND_PATTERNS = [
	[/^File is too large for (\S+) \((\d+) bytes, limit (\d+) bytes\)$/,
		_('File is too large for %s (%d bytes, limit %d bytes)', 'wrtcommander')],
	[/^Content exceeds the editor size limit \((\d+) bytes\)$/,
		_('Content exceeds the editor size limit (%d bytes)', 'wrtcommander')]
];

function translateBackendMessage(msg) {
	if (typeof msg !== 'string' || msg === '')
		return msg;

	if (BACKEND_MESSAGES[msg])
		return BACKEND_MESSAGES[msg];

	for (var i = 0; i < BACKEND_PATTERNS.length; i++) {
		var m = msg.match(BACKEND_PATTERNS[i][0]);
		if (m)
			return String.prototype.format.apply(BACKEND_PATTERNS[i][1], m.slice(1));
	}

	var idx = msg.indexOf(': ');
	if (idx > 0) {
		var head = msg.substring(0, idx);
		var tail = msg.substring(idx + 2);
		var h = BACKEND_MESSAGES[head];
		var t = translateBackendMessage(tail);
		if (h || t !== tail)
			return (h || head) + ': ' + t;
	}

	return msg;
}

function errorMessage(reply, fallback) {
	if (!reply)
		return fallback || _('Unknown error', 'wrtcommander');
	if (reply.error && reply.error.message)
		return translateBackendMessage(reply.error.message);
	return fallback || _('Unknown error', 'wrtcommander');
}

function notifyError(reply, fallback) {
	ui.addNotification(null, E('p', {}, errorMessage(reply, fallback)), 'error');
}

function notifyOk(msg) {
	ui.addNotification(null, E('p', {}, msg), 'info');
}

/* ------------------------------------------------------------------
 * directory picker (used when a copy/move target is edited by hand)
 * ------------------------------------------------------------------ */

function pickDirectory(initialPath) {
	return new Promise(function (resolve) {
		var current = initialPath || '/';
		var listNode = E('div', { class: 'fx-picker-list' });
		var pathInput = E('input', {
			type: 'text', value: current, class: 'cbi-input-text fx-picker-input'
		});

		function renderList(path) {
			listNode.innerHTML = '';
			listNode.appendChild(E('div', { class: 'fx-picker-empty' }, _('Loading…', 'wrtcommander')));
			callList(path, true).then(function (reply) {
				listNode.innerHTML = '';
				if (!reply || reply.ok === false) {
					listNode.appendChild(E('p', { class: 'alert-message warning' }, errorMessage(reply, _('Cannot open directory', 'wrtcommander'))));
					return;
				}
				current = reply.path;
				pathInput.value = current;
				var dirs = reply.entries.filter(function (e) {
					return e.type === 'directory' || (e.type === 'link' && e.target_type === 'directory');
				});
				dirs.sort(function (a, b) { return a.name.localeCompare(b.name); });
				if (reply.parent !== null)
					listNode.appendChild(E('div', { class: 'fx-picker-item', click: function () { renderList(reply.parent); } }, '↑ ..'));
				if (!dirs.length)
					listNode.appendChild(E('div', { class: 'fx-picker-empty' }, _('No subdirectories', 'wrtcommander')));
				dirs.forEach(function (d) {
					listNode.appendChild(E('div', {
						class: 'fx-picker-item',
						click: function () { renderList(joinPath(current, d.name)); }
					}, '📁 ' + d.name));
				});
			});
		}

		pathInput.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter')
				renderList(pathInput.value);
		});

		ui.showModal(_('Select destination', 'wrtcommander'), [
			pathInput,
			listNode,
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: function () { ui.hideModal(); resolve(null); } }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', {
					class: 'btn cbi-button-action',
					click: function () { ui.hideModal(); resolve(current); }
				}, _('Select this folder', 'wrtcommander'))
			])
		]);

		renderList(current);
	});
}


/* ------------------------------------------------------------------
 * ZIP reading
 *
 * Enough of the format to unpack what a phone's "Compress" button
 * produces, and no more.
 *
 * Why in the browser: a phone cannot pick a folder - `webkitdirectory`
 * is implemented by no mobile browser - but it can pick a .zip. Reading
 * the archive here rather than on the router means the router gains
 * nothing to attack: every entry becomes an ordinary upload through the
 * endpoint that was already there, with the same canon_path() in front
 * of it, so Zip Slip has nowhere to land. It also keeps `unzip` off the
 * list of things the router has to have installed.
 *
 * Refused rather than mangled: ZIP64, encrypted entries, and compression
 * methods other than stored and deflate. Deflate is unpacked by the
 * browser itself through DecompressionStream, which every browser has
 * had since May 2023; without it only a stored archive can be read.
 * ------------------------------------------------------------------ */

var ZIP_EOCD = 0x06054b50, ZIP_CD = 0x02014b50, ZIP_LFH = 0x04034b50;

/* IBM code page 437, upper half: what a ZIP filename is in when the
   entry does not carry the UTF-8 flag (bit 11). Archives made on a
   phone set that flag; ones made by Windows Explorer often do not. */
var CP437_HIGH =
	'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
	'áíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
	'└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
	'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

function zipDecodeName(bytes, utf8) {
	if (utf8)
		return new TextDecoder('utf-8').decode(bytes);
	var out = '';
	for (var i = 0; i < bytes.length; i++)
		out += (bytes[i] < 0x80)
			? String.fromCharCode(bytes[i])
			: CP437_HIGH.charAt(bytes[i] - 0x80);
	return out;
}

function zipSlice(file, from, len) {
	return file.slice(from, from + len).arrayBuffer();
}

function zipInflateAvailable() {
	try {
		return (typeof DecompressionStream !== 'undefined') && !!new DecompressionStream('deflate-raw');
	} catch (e) {
		return false;
	}
}

/* Reads the central directory and returns a Promise of the entry list.
   Nothing but the directory is read here - entry data is fetched one
   entry at a time, when it is about to be uploaded, so a large archive
   never has to fit in memory. */
function zipList(file) {
	if (file.size < 22)
		return Promise.reject(_('Not a ZIP archive, or it is damaged.', 'wrtcommander'));

	/* the end-of-central-directory record is last, but a trailing comment
	   of up to 64 KiB may follow it, so scan back over that much */
	var tailLen = Math.min(file.size, 65558);

	return zipSlice(file, file.size - tailLen, tailLen).then(function (buf) {
		var tail = new DataView(buf);
		var eocd = -1;
		for (var i = tail.byteLength - 22; i >= 0; i--) {
			if (tail.getUint32(i, true) === ZIP_EOCD) { eocd = i; break; }
		}
		if (eocd < 0)
			return Promise.reject(_('Not a ZIP archive, or it is damaged.', 'wrtcommander'));

		var count = tail.getUint16(eocd + 10, true);
		var cdSize = tail.getUint32(eocd + 12, true);
		var cdOff = tail.getUint32(eocd + 16, true);

		/* the all-ones markers mean the real values live in a ZIP64 record */
		if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF)
			return Promise.reject(_('ZIP64 archives are not supported.', 'wrtcommander'));

		return zipSlice(file, cdOff, cdSize).then(function (cdBuf) {
			var cd = new DataView(cdBuf);
			var raw = new Uint8Array(cdBuf);
			var entries = [];
			var off = 0;

			for (var n = 0; n < count; n++) {
				if (off + 46 > cd.byteLength || cd.getUint32(off, true) !== ZIP_CD)
					return Promise.reject(_('Not a ZIP archive, or it is damaged.', 'wrtcommander'));

				var flags = cd.getUint16(off + 8, true);
				var nlen = cd.getUint16(off + 28, true);
				var elen = cd.getUint16(off + 30, true);
				var clen = cd.getUint16(off + 32, true);

				entries.push({
					name: zipDecodeName(raw.subarray(off + 46, off + 46 + nlen), !!(flags & 0x800)),
					encrypted: !!(flags & 1),
					method: cd.getUint16(off + 10, true),
					csize: cd.getUint32(off + 20, true),
					usize: cd.getUint32(off + 24, true),
					lho: cd.getUint32(off + 42, true)
				});

				off += 46 + nlen + elen + clen;
			}

			return entries;
		});
	});
}

/* One entry's contents as a File. The local header has to be read too:
   its name and extra fields are not always the same length as the ones
   in the central directory, and the data starts after them. */
function zipEntryFile(file, entry, name) {
	return zipSlice(file, entry.lho, 30).then(function (buf) {
		var lh = new DataView(buf);
		if (lh.getUint32(0, true) !== ZIP_LFH)
			return Promise.reject(_('Cannot unpack "%s".', 'wrtcommander').format(entry.name));

		var start = entry.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
		var blob = file.slice(start, start + entry.csize);

		if (entry.method === 0)
			return new File([blob], name);

		return new Response(blob.stream().pipeThrough(new DecompressionStream('deflate-raw')))
			.blob()
			.then(function (out) { return new File([out], name); },
			      function () { return Promise.reject(_('Cannot unpack "%s".', 'wrtcommander').format(entry.name)); });
	});
}

/* ==================================================================
 * main view
 * ================================================================ */

return view.extend({

	load: function () {
		return Promise.resolve();
	},

	render: function () {
		var self = this;
		this.injectCss();

		this.showHidden = lsGet('showHidden', true);
		this.dirsFirst = lsGet('dirsFirst', true);
		this.rememberPaths = lsGet('rememberPaths', true);
		this.wrapEditor = lsGet('wrapEditor', true);
		this.singleClick = lsGet('singleClick', true);
		this.mobilePane = 'left';

		/* with "remember panel paths" off, both panels open where they
		   always open rather than where they were left */
		this.panes = {
			left: this.makePaneState('left',
				this.rememberPaths ? lsGet('leftPath', '/') : '/'),
			right: this.makePaneState('right',
				this.rememberPaths ? lsGet('rightPath', '/etc') : '/etc')
		};
		this.active = lsGet('activePane', 'left');
		if (this.active !== 'left' && this.active !== 'right')
			this.active = 'left';

		this.root = E('div', { class: 'fx-app' }, [
			this.headerNode = E('div', { class: 'fx-topbar' }),
			this.paneSwitchNode = E('div', { class: 'fx-pane-switch' }),
			this.panesNode = E('div', { class: 'fx-panes' }, [
				this.panes.left.node.root,
				this.panes.right.node.root
			])
		]);

		this.applyColumnWidths();
		this.renderPaneSwitch();
		this.renderHeader();

		this.keyHandler = function (ev) { self.onKeyDown(ev); };
		document.addEventListener('keydown', this.keyHandler);

		this.scheduleLayoutFit();

		this.loadPane('left');
		this.loadPane('right');

		return this.root;
	},

	/* ------------------------------------------------------------------
	 * Give the file manager the room the display actually has.
	 *
	 * Two separate adjustments, both measured rather than assumed:
	 *
	 *   height - stretch the app down to the bottom of the window, so the
	 *            panels show as many rows as fit instead of a fixed guess
	 *            at the theme's header and footer heights.
	 *
	 *   width  - relax the theme's content-width cap, but only when the
	 *            container still fits on screen afterwards. See
	 *            widenContainer() for why that check is not optional.
	 *
	 * The app itself is never moved or resized directly. Earlier versions
	 * did exactly that - width:100vw with a negative margin, then a
	 * position computed from measured geometry - and both shipped a
	 * layout that hung off the edge of the screen on a real router. What
	 * is safe is changing one property of the theme's own container and
	 * letting the theme keep doing its own centring, padding and sidebar
	 * offset.
	 * ------------------------------------------------------------------ */

	scheduleLayoutFit: function () {
		var self = this;
		var run = function () { self.fitLayout(); };

		/* the node is not in the document yet when render() returns */
		window.requestAnimationFrame(run);
		window.setTimeout(run, 100);

		if (!this.resizeHandler) {
			this.resizeHandler = function () {
				if (!self.root || !document.body.contains(self.root)) {
					window.removeEventListener('resize', self.resizeHandler);
					self.resizeHandler = null;
					self.resetContainer();
					return;
				}
				self.fitLayout();
			};
			window.addEventListener('resize', this.resizeHandler);
		}
	},

	contentContainer: function () {
		return (this.root && this.root.closest)
			? this.root.closest('#maincontent')
			: document.getElementById('maincontent');
	},

	/* Relax the theme's content-width cap for this page, but only if the
	   container still fits the window afterwards.
	 *
	 * Themes lay that element out in ways a stylesheet cannot know about
	 * in advance. On Proton2025 it is a flex item that grows into the
	 * space the cap was holding back, so raising the cap simply works and
	 * a 990px column becomes the full window width. A classic sidebar
	 * theme instead combines width:100% with a left margin for the menu,
	 * and there raising the cap pushes the right edge clean off the
	 * screen.
	 *
	 * Rather than trying to recognise the theme, this applies the class,
	 * measures the result, and takes the class straight back off if the
	 * container no longer ends inside the window. A theme this rule does
	 * not suit therefore keeps its own width instead of spilling over.
	 * The check is cheap and idempotent, so it also reruns on resize. */
	widenContainer: function () {
		var host = this.contentContainer();
		if (!host)
			return;

		host.classList.add('fx-wide');

		var vw = document.documentElement.clientWidth;
		var box = host.getBoundingClientRect();
		if (box.right > vw + 1 || box.left < -1)
			host.classList.remove('fx-wide');
	},

	/* On a phone the theme's content container can end up a good deal
	 * narrower than the screen, leaving a band of empty space beside the
	 * file list where it is least affordable.
	 *
	 * Which property causes that differs between themes and between
	 * their own breakpoints - a max-width, an auto margin, a percentage
	 * width, a padding - so this does not try to identify it. It
	 * measures: if the container is leaving more than a small gutter, it
	 * neutralises all four at once, measures again, and puts everything
	 * back if the result is not strictly better and still fully on
	 * screen. A theme this does not suit therefore keeps its own layout,
	 * exactly as with the .fx-wide class.
	 *
	 * Only below the mobile breakpoint. On a desktop the container is
	 * deliberately narrower than the window and .fx-wide already decides
	 * how much of that to take back. */
	stretchContainer: function () {
		var host = this.contentContainer();
		if (!host)
			return;

		var vw = document.documentElement.clientWidth;

		if (vw > 900) {
			this.clearStretch(host);
			return;
		}

		var before = host.getBoundingClientRect();

		/* already using the screen: nothing to do, and nothing to undo */
		if (vw - before.width <= 24) {
			this.clearStretch(host);
			return;
		}

		var saved = {
			maxWidth: host.style.maxWidth,
			width: host.style.width,
			marginLeft: host.style.marginLeft,
			marginRight: host.style.marginRight
		};

		host.style.maxWidth = 'none';
		host.style.width = '100%';
		host.style.marginLeft = '0';
		host.style.marginRight = '0';

		var after = host.getBoundingClientRect();
		var fits = (after.right <= vw + 1 && after.left >= -1 && after.width <= vw + 1);

		if (!fits || after.width <= before.width) {
			host.style.maxWidth = saved.maxWidth;
			host.style.width = saved.width;
			host.style.marginLeft = saved.marginLeft;
			host.style.marginRight = saved.marginRight;
		}
	},

	clearStretch: function (host) {
		host.style.maxWidth = '';
		host.style.width = '';
		host.style.marginLeft = '';
		host.style.marginRight = '';
	},

	/* The container outlives this view, so hand it back untouched. */
	resetContainer: function () {
		var host = this.contentContainer() || document.getElementById('maincontent');
		if (host) {
			host.classList.remove('fx-wide');
			this.clearStretch(host);
		}
	},

	fitLayout: function () {
		var el = this.root;
		if (!el || !document.body.contains(el))
			return;

		this.widenContainer();
		this.stretchContainer();

		/* start from the untouched geometry, so this is idempotent */
		el.style.height = '';

		if (document.documentElement.clientWidth < 1024)
			return;   /* one panel at a time down here; leave the theme alone */

		var top = el.getBoundingClientRect().top;
		el.style.height = Math.max(360,
			Math.round(document.documentElement.clientHeight - top - 16)) + 'px';
	},

	/* LuCI's base view renders a Save / Save & Apply / Reset footer if any
	   one of these three is non-null (luci.js: `if (this.handleSaveApply ||
	   this.handleSave || this.handleReset)`). Nulling only handleReset
	   still left the other two, so a file manager - which has no form and
	   nothing to save - was showing those buttons at the bottom of the
	   page.

	   Not merely untidy: the inherited handleSaveApply() runs
	   ui.changes.apply(), so pressing it here would commit whatever
	   unrelated staged UCI changes the session happened to be carrying,
	   from a page that never touches UCI. All three are null. */
	handleSaveApply: null,
	handleSave: null,
	handleReset: null,

	injectCss: function () {
		if (document.getElementById('wrtcommander-css'))
			return;
		document.head.appendChild(E('link', {
			id: 'wrtcommander-css',
			rel: 'stylesheet',
			href: L.resource('wrtcommander/wrtcommander.css')
		}));
	},

	/* ---------------------------------------------------- pane state */

	makePaneState: function (id, path) {
		var self = this;
		var head = E('div', { class: 'fx-pane-head' });
		var body = E('div', {
			class: 'fx-pane-body',
			/* the rows stop their own contextmenu event, so anything that
			   reaches here was a right-click on empty space: same menu,
			   without the per-file entries */
			contextmenu: function (ev) {
				ev.preventDefault();
				self.setActive(id);
				self.showContextMenu(ev, id, null);
			}
		});
		var foot = E('div', { class: 'fx-pane-foot' });
		var root = E('div', {
			class: 'fx-pane',
			click: function () { self.setActive(id); }
		}, [head, body, foot]);

		return {
			id: id,
			path: path || '/',
			parent: null,
			entries: [],
			selected: {},
			/* directory sizes, keyed by path, filled in only by an
			   explicit "calculate size" - see actCalcSize() */
			dirSizes: {},
			cursor: 0,
			visible: [],
			sortKey: lsGet(id + 'SortKey', 'name'),
			sortDir: lsGet(id + 'SortDir', 'asc'),
			disk: null,
			node: { root: root, head: head, body: body, foot: foot }
		};
	},

	other: function (id) {
		return (id === 'left') ? 'right' : 'left';
	},

	activePane: function () {
		return this.panes[this.active];
	},

	setActive: function (id) {
		if (this.active === id)
			return;
		this.active = id;
		lsSet('activePane', id);
		this.renderPaneChrome('left');
		this.renderPaneChrome('right');
		this.renderPaneSwitch();
		this.renderHeader();
	},

	renderPaneChrome: function (id) {
		var p = this.panes[id];
		p.node.root.classList.toggle('fx-pane-active', this.active === id);
		p.node.root.classList.toggle('fx-pane-shown', this.mobilePane === id);
	},

	/* page heading + the actions that are not per-file */
	/* Upload and download are the one pair in the header that has to read
	   as a matched set: same tray, arrow mirrored. No emoji pair does
	   that - the outbox/inbox trays differ only by a small arrow and read
	   as the same icon twice - so these two are drawn instead. Inline
	   markup, no icon library, and the strokes take the button's own
	   colour so both themes are handled without a second palette. */
	strokeIcon: function (paths, arrowFrom) {
		var NS = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(NS, 'svg');

		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('class', 'fx-act-svg');
		svg.setAttribute('aria-hidden', 'true');
		svg.setAttribute('focusable', 'false');

		for (var i = 0; i < paths.length; i++) {
			var el = document.createElementNS(NS, 'path');
			el.setAttribute('d', paths[i]);
			if (i >= arrowFrom)
				el.setAttribute('class', 'fx-act-svg-arrow');
			svg.appendChild(el);
		}

		return svg;
	},

	trayIcon: function (dir) {
		var up = (dir === 'up');

		return this.strokeIcon([
			/* the tray, identical for both */
			'M4.75 15.25v2.25a2.5 2.5 0 0 0 2.5 2.5h9.5a2.5 2.5 0 0 0 2.5-2.5v-2.25',
			/* the arrow is the part that carries the meaning, so it is the
			   part that gets the accent colour */
			up ? 'M12 15.5V4.25' : 'M12 4.25V15.5',
			up ? 'M7.75 8.5 12 4.25l4.25 4.25' : 'M7.75 11.25 12 15.5l4.25-4.25'
		], 1);
	},

	/* Drawn rather than U+2328: the bare glyph renders in the text font
	   and comes out far smaller than the emoji around it, while the
	   emoji-variant selector makes it a washed-out picture that vanishes
	   on dark themes. Strokes match the upload/download pair exactly. */
	keyIcon: function () {
		return this.strokeIcon([
			'M2 6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2Z',
			'M6 8.5h.01M10 8.5h.01M14 8.5h.01M18 8.5h.01',
			'M6 12h.01M10 12h.01M14 12h.01M18 12h.01',
			'M7.5 16h9'
		]);
	},

	renderHeader: function () {
		var self = this;
		var p = this.activePane();
		/* Explicit marks only, not targetEntries(): that one falls back to
		   the row under the cursor so an action always has something to
		   work on, which would make this counter read "1 selected" for
		   ever. It reports what the user marked, like the panel footer. */
		var n = p ? this.selectedEntries(p).length : 0;

		/* One icon button. The label lives in the tooltip and in the
		   shortcuts dialog: spelling every action out here would not fit
		   one row on a router's content column, and for a commander the
		   F-key is the label anyway. */
		function act(icon, key, label, fn, cls) {
			return E('button', {
				class: 'btn cbi-button fx-act' + (cls ? ' ' + cls : ''),
				title: key ? _('%s (%s)', 'wrtcommander').format(label, key) : label,
				'aria-label': label,
				click: ui.createHandlerFn(self, function () { fn(); })
			}, [
				E('span', { class: 'fx-act-ico' }, icon),
				key ? E('span', { class: 'fx-act-key' }, key) : ''
			]);
		}

		function sep() {
			return E('span', { class: 'fx-sep' });
		}

		dom.content(this.headerNode, [
			/* same string as the menu entry, so the page is titled the
			   way the user got here */
			E('h2', { class: 'fx-title' }, _('Wrt Commander')),
			sep(),

			act('\ud83d\udc41\ufe0f', 'F3', _('View', 'wrtcommander'), function () { self.actF3(); }),
			act('\ud83d\udcdd', 'F4', _('Edit', 'wrtcommander'), function () { self.actF4(); }),
			act('\ud83d\udccb', 'F5', _('Copy', 'wrtcommander'), function () { self.actF5(); }),
			act('\u27a1\ufe0f', 'F6', _('Move', 'wrtcommander'), function () { self.actF6(); }),
			act('\ud83d\udcc2', 'F7', _('New folder', 'wrtcommander'), function () { self.actF7(); }),
			act('\ud83c\udff7\ufe0f', 'F2', _('Rename', 'wrtcommander'), function () { self.actF2(); }),
			act('\ud83d\uddd1\ufe0f', 'F8', _('Delete', 'wrtcommander'), function () { self.actF8(); }, 'cbi-button-remove fx-act-danger'),
			sep(),

			act('\ud83d\udcc4', '', _('New file', 'wrtcommander'), function () { self.actNewFile(); }),
			act(self.trayIcon('up'), '', _('Upload', 'wrtcommander'), function () { self.actUpload(); }),
			act(self.trayIcon('down'), '', _('Download', 'wrtcommander'), function () { self.actDownload(); }),
			act('\ud83d\udd0d', '', _('Search', 'wrtcommander'), function () { self.actSearch(); }),

			E('span', { class: 'fx-fn-spacer' }),
			n ? E('span', { class: 'fx-fn-count' },
				N_(n, '%d selected', '%d selected', 'wrtcommander').format(n)) : '',
			act(self.keyIcon(), '', _('Keyboard shortcuts', 'wrtcommander'), function () { self.actShortcuts(); }),
			act('\u2699\ufe0f', '', _('Settings', 'wrtcommander'), function () { self.actSettings(); })
		]);
	},

	renderPaneSwitch: function () {
		var self = this;
		function tab(id, label) {
			return E('button', {
				class: 'btn fx-switch-btn' + (self.mobilePane === id ? ' fx-switch-active' : ''),
				click: function () {
					self.mobilePane = id;
					self.setActive(id);
					self.renderPaneChrome('left');
					self.renderPaneChrome('right');
					self.renderPaneSwitch();
				}
			}, label);
		}
		dom.content(this.paneSwitchNode, [
			tab('left', _('Left panel', 'wrtcommander')),
			tab('right', _('Right panel', 'wrtcommander'))
		]);
	},

	/* ------------------------------------------------------ loading */

	loadPane: function (id, keepCursor) {
		var self = this;
		var p = this.panes[id];
		dom.content(p.node.body, E('div', { class: 'fx-loading' }, _('Loading…', 'wrtcommander')));

		return callList(p.path, true).then(function (reply) {
			if (!reply || reply.ok === false) {
				notifyError(reply, _('Cannot open directory', 'wrtcommander'));
				if (p.path !== '/') {
					p.path = '/';
					return self.loadPane(id);
				}
				dom.content(p.node.body, E('div', { class: 'fx-loading' }, errorMessage(reply, _('Cannot open directory', 'wrtcommander'))));
				return;
			}
			p.path = reply.path;
			p.parent = reply.parent;
			p.entries = reply.entries;
			p.selected = {};
			p.dirSizes = {};
			if (!keepCursor)
				p.cursor = 0;
			if (self.rememberPaths)
				lsSet(id + 'Path', p.path);
			self.renderPane(id);
			self.loadDisk(id);
		}).catch(function (err) {
			ui.addNotification(null, E('p', {}, _('Request failed: %s', 'wrtcommander').format(err.message || err)), 'error');
		});
	},

	loadDisk: function (id) {
		var self = this;
		var p = this.panes[id];
		callDiskInfo(p.path).then(function (reply) {
			p.disk = (reply && reply.ok !== false) ? reply : null;
			self.renderFoot(id);
		}).catch(function () { /* non-critical */ });
	},

	navigate: function (id, path) {
		var p = this.panes[id];
		p.path = path;
		return this.loadPane(id);
	},

	refreshAll: function () {
		this.loadPane('left', true);
		this.loadPane('right', true);
	},

	/* ------------------------------------------------------ rendering */

	sortedEntries: function (p) {
		var self = this;
		var list = p.entries.filter(function (e) { return self.showHidden || !e.hidden; });
		var key = p.sortKey, dir = (p.sortDir === 'asc') ? 1 : -1;
		list.sort(function (a, b) {
			if (self.dirsFirst) {
				var ad = (a.type === 'directory'), bd = (b.type === 'directory');
				if (ad !== bd) return ad ? -1 : 1;
			}
			var av, bv;
			if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
			else if (key === 'type') { av = classify(a); bv = classify(b); }
			else { av = a[key]; bv = b[key]; }
			if (av < bv) return -1 * dir;
			if (av > bv) return 1 * dir;
			return 0;
		});
		return list;
	},

	selectedEntries: function (p) {
		return p.entries.filter(function (e) { return p.selected[e.path]; });
	},

	/* entries the next action applies to: explicit selection, else the
	   row under the cursor - classic commander behaviour */
	targetEntries: function (p) {
		var sel = this.selectedEntries(p);
		if (sel.length)
			return sel;
		var cur = p.visible[p.cursor];
		return cur ? [cur] : [];
	},

	renderPane: function (id) {
		this.renderHead(id);
		this.renderBody(id);
		this.renderFoot(id);
		this.renderPaneChrome(id);
		this.renderHeader();
	},

	renderHead: function (id) {
		var self = this;
		var p = this.panes[id];

		var input = E('input', {
			type: 'text', class: 'cbi-input-text fx-path-input', value: p.path,
			title: _('Type a path and press Enter', 'wrtcommander')
		});
		input.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter')
				self.navigate(id, input.value);
			else if (ev.key === 'Escape')
				input.value = p.path;
		});
		input.addEventListener('focus', function () { self.setActive(id); });

		var crumbs = E('div', { class: 'fx-crumbs' });
		crumbs.appendChild(E('span', {
			class: 'fx-crumb', title: _('Root directory', 'wrtcommander'),
			click: function () { self.navigate(id, '/'); }
		}, '/'));
		var acc = '';
		var parts = (p.path === '/') ? [] : p.path.split('/').filter(Boolean);
		parts.forEach(function (part, i) {
			acc = joinPath(acc || '/', part);
			var target = acc;
			if (i > 0)
				crumbs.appendChild(E('span', { class: 'fx-crumb-sep' }, '›'));
			crumbs.appendChild(E('span', {
				class: 'fx-crumb' + (i === parts.length - 1 ? ' fx-crumb-last' : ''),
				click: function () { self.navigate(id, target); }
			}, part));
		});

		dom.content(p.node.head, [
			E('div', { class: 'fx-head-row' }, [
				E('button', {
					class: 'btn fx-icon-btn', title: _('Up one level', 'wrtcommander'),
					disabled: p.parent ? null : true,
					click: function (ev) {
						ev.stopPropagation();
						if (p.parent) self.navigate(id, p.parent);
					}
				}, '↑'),
				input,
				E('button', {
					class: 'btn fx-icon-btn', title: _('Refresh', 'wrtcommander'),
					click: function (ev) { ev.stopPropagation(); self.loadPane(id, true); }
				}, '↻')
			]),
			crumbs
		]);
	},

	/* ------------------------------------------- resizable columns */

	/* Widths live as variables on the app root, so one drag moves the
	   matching column in both panes and every row follows without being
	   re-rendered. An unset variable means "use the CSS default". */
	applyColumnWidths: function () {
		if (!this.root)
			return;
		for (var key in COLUMNS) {
			var px = lsGet('col_' + key, null);
			if (typeof px === 'number' && px > 0)
				this.root.style.setProperty(COLUMNS[key].prop, Math.round(px) + 'px');
			else
				this.root.style.removeProperty(COLUMNS[key].prop);
		}
	},

	resetColumnWidth: function (key) {
		lsSet('col_' + key, null);
		this.root.style.removeProperty(COLUMNS[key].prop);
	},

	/* The handle sits on the *left* edge of the column it resizes, so
	   dragging left widens that column and gives the name column back the
	   difference. Pointer events rather than mouse events, so a touch
	   drag works too, and the pointer is captured so the drag survives
	   leaving the handle. */
	startColumnResize: function (ev, key, cell) {
		var self = this;
		var meta = COLUMNS[key];
		if (!meta || ev.button > 0)
			return;

		ev.preventDefault();
		ev.stopPropagation();

		var startX = ev.clientX;
		var startW = cell.getBoundingClientRect().width;
		var target = ev.currentTarget;

		document.body.classList.add('fx-resizing');
		try { target.setPointerCapture(ev.pointerId); } catch (e) { /* older browsers */ }

		function move(e) {
			var w = Math.round(startW + (startX - e.clientX));
			w = Math.max(meta.min, Math.min(meta.max, w));
			self.root.style.setProperty(meta.prop, w + 'px');
		}

		function done(e) {
			target.removeEventListener('pointermove', move);
			target.removeEventListener('pointerup', done);
			target.removeEventListener('pointercancel', done);
			document.body.classList.remove('fx-resizing');
			try { target.releasePointerCapture(e.pointerId); } catch (er) { /* ignore */ }

			var v = self.root.style.getPropertyValue(meta.prop);
			var px = parseInt(v, 10);
			if (px > 0)
				lsSet('col_' + key, px);
		}

		target.addEventListener('pointermove', move);
		target.addEventListener('pointerup', done);
		target.addEventListener('pointercancel', done);
	},

	renderBody: function (id) {
		var self = this;
		var p = this.panes[id];
		var list = this.sortedEntries(p);
		p.visible = list;
		if (p.cursor >= list.length)
			p.cursor = Math.max(0, list.length - 1);

		/* `resize` names the column this header can be dragged to resize;
		   omitted for the name column, which is the one that absorbs
		   whatever the others give up. */
		function sortHeader(label, key, cls, resize) {
			var arrow = (p.sortKey === key) ? (p.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
			var cell = E('div', {
				class: 'fx-cell fx-th ' + cls,
				click: function (ev) {
					ev.stopPropagation();
					self.setActive(id);
					if (p.sortKey === key)
						p.sortDir = (p.sortDir === 'asc') ? 'desc' : 'asc';
					else { p.sortKey = key; p.sortDir = 'asc'; }
					lsSet(id + 'SortKey', p.sortKey);
					lsSet(id + 'SortDir', p.sortDir);
					self.renderBody(id);
				}
			}, label + arrow);

			if (resize) {
				cell.appendChild(E('span', {
					class: 'fx-resizer',
					title: _('Drag to resize, double-click to reset', 'wrtcommander'),
					pointerdown: function (ev) { self.startColumnResize(ev, resize, cell); },
					/* the handle lives inside the sort header, so both of
					   these have to stop here or a resize would also sort */
					click: function (ev) { ev.stopPropagation(); },
					dblclick: function (ev) {
						ev.stopPropagation();
						self.resetColumnWidth(resize);
					}
				}));
			}

			return cell;
		}

		var rows = [
			E('div', { class: 'fx-row fx-header' }, [
				E('div', { class: 'fx-cell fx-c-mark' }, ''),
				sortHeader(_('Name', 'wrtcommander'), 'name', 'fx-c-name'),
				sortHeader(_('Size', 'wrtcommander'), 'size', 'fx-c-size', 'size'),
				sortHeader(_('Modified', 'wrtcommander'), 'mtime', 'fx-c-time', 'time'),
				/* short label on purpose: this column shows the mode string
				   (-rw-r--r--), and the full word does not fit a half-width
				   panel once translated */
				sortHeader(_('Mode', 'wrtcommander'), 'mode_octal', 'fx-c-perm', 'perm')
			])
		];

		if (p.parent) {
			rows.push(E('div', {
				class: 'fx-row fx-updir',
				/* both handlers go through claimOpen(), so a double
				   click here goes up one level and not two */
				dblclick: function (ev) {
					if (!self.singleClick && self.claimOpen(ev))
						self.navigate(id, p.parent);
				},
				click: function (ev) {
					ev.stopPropagation();
					self.setActive(id);
					if (self.claimOpen(ev))
						self.navigate(id, p.parent);
				}
			}, [
				E('div', { class: 'fx-cell fx-c-mark' }, ''),
				E('div', { class: 'fx-cell fx-c-name' }, '↑ ..'),
				E('div', { class: 'fx-cell fx-c-size' }, _('up', 'wrtcommander')),
				E('div', { class: 'fx-cell fx-c-time' }, ''),
				E('div', { class: 'fx-cell fx-c-perm' }, '')
			]));
		}

		if (!list.length) {
			rows.push(E('div', { class: 'fx-empty' }, _('This directory is empty', 'wrtcommander')));
		}

		list.forEach(function (entry, idx) {
			rows.push(self.renderRow(id, entry, idx));
		});

		dom.content(p.node.body, rows);
		this.scrollCursorIntoView(id);
	},

	renderRow: function (id, entry, idx) {
		var self = this;
		var p = this.panes[id];
		var cls = classify(entry);
		var isSel = !!p.selected[entry.path];
		var isCur = (p.cursor === idx);

		/* A directory has no size of its own - the number people want is
		   the sum of its whole subtree, which costs a full walk. So the
		   column shows the type until someone asks for the total, and
		   the answer replaces it once it arrives. */
		var sizeInfo = (entry.type === 'directory') ? p.dirSizes[entry.path] : null;
		var sizeText, sizeTitle = '';

		var sizeClass = '';

		if (entry.type !== 'directory') {
			sizeText = fmtSize(entry.size);
		}
		else if (!sizeInfo) {
			/* the same dash fmtSize() uses for a size that is not known,
			   because that is exactly what this is - the column says
			   nothing rather than saying something that is not a size */
			sizeText = '—';
			sizeTitle = _('Ctrl+Space calculates the size of this folder', 'wrtcommander');
		}
		else if (sizeInfo.pending) {
			sizeText = '…';
			sizeClass = ' fx-size-busy';
			sizeTitle = _('Calculating…', 'wrtcommander');
		}
		else if (sizeInfo.failed) {
			/* back to the dash, but coloured: otherwise a failed walk is
			   indistinguishable from one that was never asked for */
			sizeText = '—';
			sizeClass = ' fx-size-failed';
			sizeTitle = sizeInfo.failed;
		}
		else {
			/* a capped walk gives a lower bound, and says so rather than
			   presenting a partial total as the answer */
			sizeText = (sizeInfo.truncated ? '>' : '') + fmtSize(sizeInfo.size);
			sizeTitle = sizeInfo.truncated
				? _('At least %s: the folder is too large to measure in full.', 'wrtcommander').format(fmtSize(sizeInfo.size))
				: N_(sizeInfo.files, '%d file', '%d files', 'wrtcommander').format(sizeInfo.files);
		}

		var mark = E('span', {
			class: 'fx-mark' + (isSel ? ' fx-mark-on' : ''),
			title: _('Select', 'wrtcommander'),
			click: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				self.toggleSelect(id, entry);
				/* redraw: the box glyph, the row highlight, the footer
				   total and the toolbar counter all follow this */
				self.renderBody(id);
				self.renderFoot(id);
				self.renderHeader();
			}
		}, isSel ? '■' : '□');

		var nameText = entry.name;
		if (entry.is_symlink)
			nameText += ' → ' + (entry.symlink_target || '?');

		var row = E('div', {
			class: 'fx-row fx-item' +
				(isSel ? ' fx-selected' : '') +
				(isCur ? ' fx-cursor' : '') +
				(entry.hidden ? ' fx-hidden-item' : '') +
				(entry.broken ? ' fx-broken' : ''),
			click: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;

				/* Ctrl/Cmd-click marks the row instead of opening it.
				   With "open with a single click" on, a plain click is
				   spoken for, and this is the way back to touching a row
				   without opening it - the mark box in the first column
				   being the other one. */
				if (ev.ctrlKey || ev.metaKey) {
					self.toggleSelect(id, entry);
					self.renderBody(id);
					self.renderFoot(id);
					self.renderHeader();
					return;
				}

				self.renderBody(id);
				self.renderFoot(id);

				if (self.singleClick && self.claimOpen(ev))
					self.openEntry(id, entry);
			},
			dblclick: function (ev) {
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;
				/* in single-click mode the first of the two clicks has
				   already opened this row, and the list under the pointer
				   is no longer the list that was clicked */
				if (!self.singleClick && self.claimOpen(ev))
					self.openEntry(id, entry);
			},
			contextmenu: function (ev) {
				ev.preventDefault();
				ev.stopPropagation();
				self.setActive(id);
				p.cursor = idx;
				self.renderBody(id);
				self.showContextMenu(ev, id, entry);
			}
		}, [
			E('div', { class: 'fx-cell fx-c-mark' }, mark),
			E('div', { class: 'fx-cell fx-c-name', title: entry.name }, [
				E('span', { class: 'fx-ico' }, iconFor(entry, cls)),
				E('span', { class: 'fx-nm' }, nameText)
			]),
			E('div', { class: 'fx-cell fx-c-size' + sizeClass, title: sizeTitle }, sizeText),
			E('div', { class: 'fx-cell fx-c-time' }, fmtTime(entry.mtime)),
			E('div', { class: 'fx-cell fx-c-perm' }, entry.mode_string)
		]);

		return row;
	},

	renderFoot: function (id) {
		var p = this.panes[id];
		var sel = this.selectedEntries(p);
		var bytes = 0;
		sel.forEach(function (e) { if (e.type !== 'directory') bytes += e.size; });

		var left = sel.length
			? E('span', { class: 'fx-foot-sel' },
				N_(sel.length, '%d item selected', '%d items selected', 'wrtcommander').format(sel.length) +
				(bytes > 0 ? ' · ' + fmtSize(bytes) : ''))
			: E('span', {}, N_(p.visible.length, '%d item', '%d items', 'wrtcommander').format(p.visible.length));

		var right = p.disk
			? E('span', { class: 'fx-foot-disk', title: p.disk.filesystem + ' (' + p.disk.fstype + ')' },
				_('%s free of %s', 'wrtcommander').format(fmtSize(p.disk.free), fmtSize(p.disk.total)))
			: E('span', {}, '');

		dom.content(p.node.foot, [left, right]);
	},

	scrollCursorIntoView: function (id) {
		var p = this.panes[id];
		var el = p.node.body.querySelector('.fx-cursor');
		if (el && el.scrollIntoView)
			el.scrollIntoView({ block: 'nearest' });
	},

	/* -------------------------------------------------- function bar */


	/* ---------------------------------------------------- keyboard */

	onKeyDown: function (ev) {
		/* never hijack typing in a field or while a modal is open */
		var t = ev.target;
		if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
			return;
		if (document.querySelector('body.modal-overlay-active, .modal'))
			return;
		if (!this.root || !document.body.contains(this.root))
			return;

		var id = this.active;
		var p = this.panes[id];
		var handled = true;

		switch (ev.key) {
			case 'Tab':
				this.mobilePane = this.other(id);
				this.setActive(this.other(id));
				this.renderPaneChrome('left');
				this.renderPaneChrome('right');
				this.renderPaneSwitch();
				break;
			case 'ArrowDown':
				p.cursor = Math.min(p.cursor + 1, p.visible.length - 1);
				this.renderBody(id); this.renderFoot(id); this.renderHeader();
				break;
			case 'ArrowUp':
				p.cursor = Math.max(p.cursor - 1, 0);
				this.renderBody(id); this.renderFoot(id); this.renderHeader();
				break;
			case 'PageDown':
				p.cursor = Math.min(p.cursor + 10, p.visible.length - 1);
				this.renderBody(id); this.renderHeader();
				break;
			case 'PageUp':
				p.cursor = Math.max(p.cursor - 10, 0);
				this.renderBody(id); this.renderHeader();
				break;
			case 'Home':
				p.cursor = 0; this.renderBody(id); this.renderHeader();
				break;
			case 'End':
				p.cursor = Math.max(0, p.visible.length - 1);
				this.renderBody(id); this.renderHeader();
				break;
			case 'Enter':
				if (p.visible[p.cursor]) this.openEntry(id, p.visible[p.cursor]);
				break;
			case 'Backspace':
				if (p.parent) this.navigate(id, p.parent);
				break;
			case 'Insert':
			case ' ':
				/* Ctrl+Space is "calculate this folder's size", as in
				   Midnight Commander; plain Space marks the row */
				if (ev.key === ' ' && (ev.ctrlKey || ev.metaKey)) {
					this.actCalcSize();
				}
				else if (p.visible[p.cursor]) {
					this.toggleSelect(id, p.visible[p.cursor]);
					p.cursor = Math.min(p.cursor + 1, p.visible.length - 1);
					this.renderBody(id); this.renderFoot(id); this.renderHeader();
				}
				break;
			case 'F2': this.actF2(); break;
			case 'F3': this.actF3(); break;
			case 'F4': this.actF4(); break;
			case 'F5': this.actF5(); break;
			case 'F6': this.actF6(); break;
			case 'F7': this.actF7(); break;
			case 'F8':
			case 'Delete': this.actF8(); break;
			case 'a':
			case 'A':
				if (ev.ctrlKey || ev.metaKey) {
					/* toggles: a second Ctrl+A clears again */
					if (this.selectedEntries(p).length === p.visible.length)
						this.clearSelection(id);
					else
						this.selectAll(id);
				} else handled = false;
				break;
			case 'r':
			case 'R':
				if (ev.ctrlKey || ev.metaKey) this.loadPane(id, true);
				else handled = false;
				break;
			default:
				handled = false;
		}

		if (handled) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	},

	selectAll: function (id) {
		var p = this.panes[id];
		p.selected = {};
		p.visible.forEach(function (e) { p.selected[e.path] = true; });
		this.renderBody(id); this.renderFoot(id); this.renderHeader();
	},

	clearSelection: function (id) {
		this.panes[id].selected = {};
		this.renderBody(id); this.renderFoot(id); this.renderHeader();
	},

	toggleSelect: function (id, entry) {
		var p = this.panes[id];
		if (p.selected[entry.path])
			delete p.selected[entry.path];
		else
			p.selected[entry.path] = true;
	},

	/* One open per gesture, whichever handler asks for it.

	   A tap is very often a double tap, and with "open with a single
	   click" on, the second click lands on a list the first click has
	   already replaced - so it would open whatever now happens to sit
	   under the finger. Two signals, because neither covers both input
	   methods on its own:

	     - `ev.detail` is the browser's own click counter, so the second
	       *click* of a real double-click carries 2 and is refused
	       however slowly it was made. It is read only on a click: a
	       dblclick event legitimately carries 2 as well, and that one is
	       the open in double-click mode. Synthesised events and some
	       touch stacks leave it at 0 or 1, which is why it is not the
	       only test.
	     - a short window since the last open, deliberately shorter than
	       a double-click threshold: a stray second tap arrives inside
	       it, while someone who has seen the new list and picked a row
	       cannot.

	   Only the *open* is suppressed. The cursor still moves and the
	   panel still becomes active. */
	claimOpen: function (ev) {
		if (ev && ev.type === 'click' && ev.detail > 1)
			return false;
		var now = Date.now();
		if (now - (this._lastOpen || 0) < 250)
			return false;
		this._lastOpen = now;
		return true;
	},

	openEntry: function (id, entry) {
		if (entry.type === 'directory' || (entry.type === 'link' && entry.target_type === 'directory')) {
			this.navigate(id, entry.path);
			return;
		}
		if (entry.type === 'link' && entry.broken) {
			ui.addNotification(null, E('p', {}, _('Broken symlink: %s', 'wrtcommander').format(entry.symlink_target || '?')), 'warning');
			return;
		}
		this.previewEntry(entry);
	},

	/* ------------------------------------------------ context menu */

	/* One menu builder for both cases: right-clicking a row, and
	   right-clicking the empty space below the rows (entry === null).
	   Everything that can be reached from the header or the keyboard is
	   reachable here too, so the menu is a complete alternative to both.

	   Which entries an action applies to follows the same rule as the
	   function keys: an explicit selection wins, and the clicked row is
	   used only when nothing is marked. Right-clicking a row outside the
	   selection moves the cursor there and acts on that row alone, which
	   is what makes "select three, right-click one of them, Delete" mean
	   all three rather than one. */
	showContextMenu: function (ev, id, entry) {
		var self = this;
		this.closeContextMenu();

		var p = this.panes[id];
		var sel = this.selectedEntries(p);
		var targets = (entry && sel.length && p.selected[entry.path]) ? sel
		            : (entry ? [entry] : sel);
		var many = targets.length > 1;
		var one = (targets.length === 1) ? targets[0] : null;
		var isDir = !!(one && one.type === 'directory');
		var SEP = null;

		var items = [];

		if (one) {
			items.push([_('Open', 'wrtcommander'), 'Enter', function () { self.openEntry(id, one); }]);
			if (!isDir) {
				items.push([_('View', 'wrtcommander'), 'F3', function () { self.previewEntry(one); }]);
				items.push([_('Edit', 'wrtcommander'), 'F4', function () { self.editEntry(one); }]);
				items.push([_('Download', 'wrtcommander'), '', function () { self.downloadEntry(one); }]);
			}
			items.push(SEP);
		}

		if (targets.length) {
			items.push([many ? N_(targets.length, 'Copy — %d item', 'Copy — %d items', 'wrtcommander').format(targets.length)
				: _('Copy', 'wrtcommander'), 'F5',
				function () { self.copyOrMove('copy', id, targets); }]);
			items.push([many ? N_(targets.length, 'Move — %d item', 'Move — %d items', 'wrtcommander').format(targets.length)
				: _('Move', 'wrtcommander'), 'F6',
				function () { self.copyOrMove('move', id, targets); }]);
			if (one)
				items.push([_('Rename', 'wrtcommander'), 'F2', function () { self.renameEntry(id, one); }]);
			items.push([many ? N_(targets.length, 'Delete — %d item', 'Delete — %d items', 'wrtcommander').format(targets.length)
				: _('Delete', 'wrtcommander'), 'F8',
				function () { self.deleteEntries(id, targets); }, 'fx-ctx-danger']);
			items.push(SEP);
		}

		if (targets.some(function (t) { return t.type === 'directory'; })) {
			items.push([_('Calculate size', 'wrtcommander'), 'Ctrl+Space', function () {
				self.setActive(id);
				self.actCalcSize();
			}]);
			items.push(SEP);
		}

		if (entry) {
			items.push([p.selected[entry.path] ? _('Unselect', 'wrtcommander') : _('Select', 'wrtcommander'), 'Space',
				function () {
					self.toggleSelect(id, entry);
					self.renderBody(id); self.renderFoot(id); self.renderHeader();
				}]);
		}
		items.push([_('Select all', 'wrtcommander'), 'Ctrl+A', function () { self.selectAll(id); }]);
		if (sel.length)
			items.push([_('Clear selection', 'wrtcommander'), '', function () { self.clearSelection(id); }]);
		items.push(SEP);

		items.push([_('New file', 'wrtcommander'), '', function () { self.setActive(id); self.newFile(); }]);
		items.push([_('New folder', 'wrtcommander'), 'F7', function () { self.setActive(id); self.newDirectory(); }]);
		items.push([_('Upload', 'wrtcommander'), '', function () { self.setActive(id); self.actUpload(); }]);
		if (this.folderPickerSupported())
			items.push([_('Upload folder', 'wrtcommander'), '', function () { self.setActive(id); self.actUploadFolder(); }]);
		items.push([_('Upload folder from a ZIP', 'wrtcommander'), '', function () { self.setActive(id); self.actUploadZip(); }]);
		items.push(SEP);

		if (one && one.type !== 'link')
			items.push([_('Permissions', 'wrtcommander'), '', function () { self.permissionsEntry(id, one); }]);
		if (one)
			items.push([_('Properties', 'wrtcommander'), '', function () { self.propertiesEntry(one); }]);
		items.push([_('Search', 'wrtcommander'), '', function () { self.setActive(id); self.actSearch(); }]);
		items.push([_('Refresh', 'wrtcommander'), 'Ctrl+R', function () { self.loadPane(id); }]);

		/* drop a separator that ended up first, last, or next to another */
		var clean = [];
		items.forEach(function (it) {
			if (it === SEP) {
				if (clean.length && clean[clean.length - 1] !== SEP)
					clean.push(SEP);
			} else {
				clean.push(it);
			}
		});
		while (clean.length && clean[clean.length - 1] === SEP)
			clean.pop();

		var menu = E('div', { class: 'fx-ctx' }, clean.map(function (it) {
			if (it === SEP)
				return E('div', { class: 'fx-ctx-sep' });
			return E('div', {
				class: 'fx-ctx-item' + (it[3] ? ' ' + it[3] : ''),
				click: function () { self.closeContextMenu(); it[2](); }
			}, [
				E('span', { class: 'fx-ctx-label' }, it[0]),
				E('span', { class: 'fx-ctx-key' }, it[1] || '')
			]);
		}));

		menu.style.left = ev.clientX + 'px';
		menu.style.top = ev.clientY + 'px';
		document.body.appendChild(menu);

		var r = menu.getBoundingClientRect();
		if (r.right > window.innerWidth)
			menu.style.left = Math.max(0, window.innerWidth - r.width - 8) + 'px';
		if (r.bottom > window.innerHeight)
			menu.style.top = Math.max(0, window.innerHeight - r.height - 8) + 'px';

		this._ctx = menu;
		this._ctxClose = function (e) { if (!menu.contains(e.target)) self.closeContextMenu(); };
		window.setTimeout(function () {
			document.addEventListener('click', self._ctxClose);
			document.addEventListener('contextmenu', self._ctxClose);
		}, 0);
	},

	closeContextMenu: function () {
		if (this._ctx) { this._ctx.remove(); this._ctx = null; }
		if (this._ctxClose) {
			document.removeEventListener('click', this._ctxClose);
			document.removeEventListener('contextmenu', this._ctxClose);
			this._ctxClose = null;
		}
	},

	/* --------------------------------------------- function actions */

	actF2: function () {
		var id = this.active, p = this.panes[id];
		var t = this.targetEntries(p);
		if (t.length === 1) this.renameEntry(id, t[0]);
		else if (t.length) ui.addNotification(null, E('p', {}, _('Select exactly one item to rename.', 'wrtcommander')), 'warning');
	},

	actF3: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.previewEntry(t[0]);
	},

	actF4: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.editEntry(t[0]);
	},

	actF5: function () {
		var id = this.active;
		this.copyOrMove('copy', id, this.targetEntries(this.panes[id]));
	},

	actF6: function () {
		var id = this.active;
		this.copyOrMove('move', id, this.targetEntries(this.panes[id]));
	},

	actF7: function () { this.newDirectory(); },

	actF8: function () {
		var id = this.active;
		this.deleteEntries(id, this.targetEntries(this.panes[id]));
	},

	/* Midnight Commander puts this on Ctrl+Space and so does this: it is
	   the one action a two-pane manager needs that no toolbar button can
	   sensibly own, because it is per-folder and takes real time. Runs
	   over the marked folders, or the one under the cursor. */
	actCalcSize: function () {
		var self = this;
		var id = this.active, p = this.panes[id];
		var dirs = this.targetEntries(p).filter(function (e) {
			return e.type === 'directory';
		});

		if (!dirs.length) {
			ui.addNotification(null, E('p', {},
				_('Select a folder to calculate its size.', 'wrtcommander')), 'warning');
			return;
		}

		dirs.forEach(function (d) { p.dirSizes[d.path] = { pending: true }; });
		this.renderBody(id);

		/* one at a time: each of these walks a subtree, and firing them
		   all at once would have a router's rpcd running several full
		   filesystem walks in parallel */
		var next = function (i) {
			if (i >= dirs.length)
				return;
			var d = dirs[i];
			return callDirSize(d.path).then(function (r) {
				if (!r || r.ok === false) {
					p.dirSizes[d.path] = {
						failed: errorMessage(r, _('Cannot read properties', 'wrtcommander'))
					};
				} else {
					p.dirSizes[d.path] = {
						size: r.size,
						files: r.files,
						dirs: r.dirs,
						truncated: !!r.truncated
					};
				}
				self.renderBody(id);
				return next(i + 1);
			}).catch(function (err) {
				p.dirSizes[d.path] = { failed: err.message || String(err) };
				self.renderBody(id);
				return next(i + 1);
			});
		};
		next(0);
	},

	actNewFile: function () { this.newFile(); },

	actDownload: function () {
		var t = this.targetEntries(this.activePane());
		if (t.length === 1 && t[0].type !== 'directory') this.downloadEntry(t[0]);
		else if (t.length) ui.addNotification(null, E('p', {}, _('Select exactly one file to download.', 'wrtcommander')), 'warning');
	},

	/* ------------------------------------------------ create/rename */

	validateName: function (name) {
		if (!name || !name.length) return _('Name cannot be empty', 'wrtcommander');
		if (name === '.' || name === '..') return _('Invalid name', 'wrtcommander');
		if (name.indexOf('/') >= 0) return _('Name cannot contain a slash', 'wrtcommander');
		if (name.length > 255) return _('Name is too long', 'wrtcommander');
		return null;
	},

	promptName: function (title, initial, okLabel) {
		var self = this;
		return new Promise(function (resolve) {
			var input = E('input', { type: 'text', class: 'cbi-input-text fx-full', value: initial || '' });
			var err = E('div', { class: 'fx-form-error' });
			function submit() {
				var e = self.validateName(input.value);
				if (e) { err.textContent = e; return; }
				ui.hideModal();
				resolve(input.value);
			}
			input.addEventListener('keydown', function (ev) {
				ev.stopPropagation();
				if (ev.key === 'Enter') submit();
			});
			ui.showModal(title, [
				E('div', { class: 'cbi-value' }, [
					E('label', { class: 'cbi-value-title' }, _('Name', 'wrtcommander')),
					input
				]),
				err,
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: function () { ui.hideModal(); resolve(null); } }, _('Cancel', 'wrtcommander')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: submit }, okLabel || _('Create', 'wrtcommander'))
				])
			]);
			input.focus();
			input.select();
		});
	},

	newFile: function () {
		var self = this, id = this.active, p = this.panes[id];
		this.promptName(_('New file', 'wrtcommander'), '').then(function (name) {
			if (!name) return;
			callCreate(joinPath(p.path, name)).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot create file', 'wrtcommander'));
				notifyOk(_('File created', 'wrtcommander'));
				self.loadPane(id, true);
			});
		});
	},

	newDirectory: function () {
		var self = this, id = this.active, p = this.panes[id];
		this.promptName(_('New folder', 'wrtcommander'), '').then(function (name) {
			if (!name) return;
			callMkdir(joinPath(p.path, name)).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot create folder', 'wrtcommander'));
				notifyOk(_('Folder created', 'wrtcommander'));
				self.loadPane(id, true);
			});
		});
	},

	renameEntry: function (id, entry) {
		var self = this;
		this.promptName(_('Rename', 'wrtcommander'), entry.name, _('Rename', 'wrtcommander')).then(function (name) {
			if (!name || name === entry.name) return;
			callRename(entry.path, name).then(function (r) {
				if (!r || r.ok === false) return notifyError(r, _('Cannot rename', 'wrtcommander'));
				notifyOk(_('Renamed', 'wrtcommander'));
				self.loadPane(id, true);
			});
		});
	},

	/* ------------------------------------------------------- delete */

	deleteEntries: function (id, entries) {
		var self = this;
		if (!entries.length) return;

		var SYSTEM = ['/etc', '/overlay', '/rom', '/usr', '/lib', '/bin', '/sbin', '/boot', '/www'];
		var systemish = entries.some(function (e) { return SYSTEM.indexOf(e.path) >= 0; });

		var msg;
		if (entries.length === 1)
			msg = (entries[0].type === 'directory')
				? _('Delete folder "%s" and all of its contents?', 'wrtcommander').format(entries[0].name)
				: _('Delete "%s"?', 'wrtcommander').format(entries[0].name);
		else
			msg = N_(entries.length, 'Delete %d selected item?', 'Delete %d selected items?', 'wrtcommander').format(entries.length);

		var body = [
			E('p', {}, msg),
			E('div', { class: 'fx-del-list' }, entries.slice(0, 12).map(function (e) {
				return E('div', {}, e.path);
			}).concat(entries.length > 12
				? [E('div', {}, _('…and %d more', 'wrtcommander').format(entries.length - 12))] : [])),
			E('p', { class: 'fx-warn' }, _('This action cannot be undone.', 'wrtcommander'))
		];
		if (systemish)
			body.push(E('p', { class: 'fx-warn fx-warn-strong' },
				_('WARNING: this includes a core system path. Deleting it can break the router.', 'wrtcommander')));

		ui.showModal(_('Confirm delete', 'wrtcommander'), body.concat([
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', {
					class: 'btn cbi-button-remove',
					click: function () {
						ui.hideModal();
						callRemove(entries.map(function (e) { return e.path; })).then(function (r) {
							if (!r || r.ok === false) return notifyError(r, _('Delete failed', 'wrtcommander'));
							self.reportBulk(r, _('Deleted', 'wrtcommander'));
							self.refreshAll();
						});
					}
				}, _('Delete', 'wrtcommander'))
			])
		]));
	},

	/* --------------------------------------------------- copy / move */

	copyOrMove: function (mode, id, entries) {
		var self = this;
		if (!entries.length) return;

		var destPane = this.panes[this.other(id)];
		var destInput = E('input', { type: 'text', class: 'cbi-input-text fx-full', value: destPane.path });
		destInput.addEventListener('keydown', function (ev) { ev.stopPropagation(); });

		var title = (mode === 'copy') ? _('Copy', 'wrtcommander') : _('Move', 'wrtcommander');
		var heading = (entries.length === 1)
			? ((mode === 'copy')
				? _('Copy "%s" to:', 'wrtcommander').format(entries[0].name)
				: _('Move "%s" to:', 'wrtcommander').format(entries[0].name))
			: ((mode === 'copy')
				? N_(entries.length, 'Copy %d item to:', 'Copy %d items to:', 'wrtcommander').format(entries.length)
				: N_(entries.length, 'Move %d item to:', 'Move %d items to:', 'wrtcommander').format(entries.length));

		function run(destination, overwrite) {
			var items = entries.map(function (e) { return e.path; });
			var call = (mode === 'copy') ? callCopy : callMove;
			return call(items, destination, !!overwrite).then(function (r) {
				if (!r || r.ok === false) {
					notifyError(r, _('Operation failed', 'wrtcommander'));
					return;
				}
				var conflicts = (r.results || []).filter(function (x) {
					return !x.ok && x.error && x.error.code === 'EEXIST';
				});
				if (conflicts.length && !overwrite) {
					self.confirmOverwrite(conflicts.length, function () {
						run(destination, true).then(function () { self.refreshAll(); });
					});
					self.refreshAll();
					return;
				}
				self.reportBulk(r, (mode === 'copy') ? _('Copied', 'wrtcommander') : _('Moved', 'wrtcommander'));
				self.refreshAll();
			});
		}

		ui.showModal(title, [
			E('p', {}, heading),
			E('div', { class: 'fx-del-list' }, entries.slice(0, 12).map(function (e) {
				return E('div', {}, e.path);
			}).concat(entries.length > 12
				? [E('div', {}, _('…and %d more', 'wrtcommander').format(entries.length - 12))] : [])),
			E('div', { class: 'fx-dest-row' }, [
				destInput,
				E('button', {
					class: 'btn', click: function () {
						pickDirectory(destInput.value).then(function (d) { if (d) destInput.value = d; });
					}
				}, _('Browse…', 'wrtcommander'))
			]),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', {
					class: 'btn cbi-button-action',
					click: function () {
						var d = destInput.value;
						ui.hideModal();
						run(d, false);
					}
				}, title)
			])
		]);
	},

	confirmOverwrite: function (n, onYes) {
		ui.showModal(_('Items already exist', 'wrtcommander'), [
			E('p', {}, N_(n, '%d item already exists at the destination. Overwrite it?',
				'%d items already exist at the destination. Overwrite them?',
				'wrtcommander').format(n)),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', {
					class: 'btn cbi-button-negative',
					click: function () { ui.hideModal(); onYes(); }
				}, _('Overwrite', 'wrtcommander'))
			])
		]);
	},

	reportBulk: function (reply, okMsg) {
		var failed = (reply.results || []).filter(function (r) { return !r.ok; });
		if (!failed.length) { notifyOk(okMsg); return; }
		ui.addNotification(null, E('div', {}, failed.map(function (f) {
			return E('p', {}, (f.path || '') + ': ' + errorMessage(f, _('failed', 'wrtcommander')));
		})), 'error');
	},

	/* ---------------------------------------------------- properties */

	propertiesEntry: function (entry) {
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read properties', 'wrtcommander'));
			var rows = [
				[_('Name', 'wrtcommander'), st.name],
				[_('Path', 'wrtcommander'), st.path],
				[_('Type', 'wrtcommander'), typeLabel(classify(st))],
				[_('Size', 'wrtcommander'), st.type === 'directory' ? '—' : fmtSize(st.size)],
				[_('Owner', 'wrtcommander'), st.owner + ' (' + st.uid + ')'],
				[_('Group', 'wrtcommander'), st.group + ' (' + st.gid + ')'],
				[_('Permissions', 'wrtcommander'), st.mode_string + ' (' + st.mode_octal + ')'],
				[_('Modified', 'wrtcommander'), fmtTime(st.mtime)],
				[_('Accessed', 'wrtcommander'), fmtTime(st.atime)],
				[_('Changed', 'wrtcommander'), fmtTime(st.ctime)],
				[_('Filesystem', 'wrtcommander'), st.fstype + ' · ' + st.mount]
			];
			if (st.is_symlink)
				rows.splice(3, 0, [_('Symlink target', 'wrtcommander'),
					st.broken ? _('%s (broken)', 'wrtcommander').format(st.symlink_target) : st.symlink_target]);

			ui.showModal(_('Properties', 'wrtcommander'), [
				E('table', { class: 'table fx-props' }, rows.map(function (r) {
					return E('tr', { class: 'tr' }, [
						E('td', { class: 'td fx-prop-k' }, r[0]),
						E('td', { class: 'td fx-prop-v' }, String(r[1]))
					]);
				})),
				E('div', { class: 'right fx-modal-actions' },
					E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander')))
			]);
		});
	},

	/* --------------------------------------------------- permissions */

	permissionsEntry: function (id, entry) {
		var self = this;
		callStat(entry.path).then(function (st) {
			if (!st || st.ok === false) return notifyError(st, _('Cannot read permissions', 'wrtcommander'));
			var octal = parseInt(st.mode_octal, 8);
			var checks = {};

			function bit(mask) { return (octal & mask) !== 0; }

			function row(label, keys, masks) {
				var cells = [E('td', { class: 'td' }, label)];
				keys.forEach(function (k, i) {
					checks[k] = E('input', { type: 'checkbox' });
					checks[k].checked = bit(masks[i]);
					checks[k].addEventListener('change', recompute);
					cells.push(E('td', { class: 'td' }, checks[k]));
				});
				return E('tr', { class: 'tr' }, cells);
			}

			var preview = E('div', { class: 'fx-mode-preview' });

			function recompute() {
				var m =
					(checks.ur.checked ? 0o400 : 0) | (checks.uw.checked ? 0o200 : 0) | (checks.ux.checked ? 0o100 : 0) |
					(checks.gr.checked ? 0o040 : 0) | (checks.gw.checked ? 0o020 : 0) | (checks.gx.checked ? 0o010 : 0) |
					(checks.or.checked ? 0o004 : 0) | (checks.ow.checked ? 0o002 : 0) | (checks.ox.checked ? 0o001 : 0);
				var s = '';
				s += checks.ur.checked ? 'r' : '-';
				s += checks.uw.checked ? 'w' : '-';
				s += checks.ux.checked ? 'x' : '-';
				s += checks.gr.checked ? 'r' : '-';
				s += checks.gw.checked ? 'w' : '-';
				s += checks.gx.checked ? 'x' : '-';
				s += checks.or.checked ? 'r' : '-';
				s += checks.ow.checked ? 'w' : '-';
				s += checks.ox.checked ? 'x' : '-';
				preview.textContent = s + '  ' + ('0000' + m.toString(8)).slice(-4);
				return m;
			}

			var table = E('table', { class: 'table' }, [
				E('tr', { class: 'tr table-titles' }, [
					E('th', { class: 'th' }, ''),
					E('th', { class: 'th' }, _('Read', 'wrtcommander')),
					E('th', { class: 'th' }, _('Write', 'wrtcommander')),
					E('th', { class: 'th' }, _('Execute', 'wrtcommander'))
				]),
				row(_('Owner', 'wrtcommander'), ['ur', 'uw', 'ux'], [0o400, 0o200, 0o100]),
				row(_('Group', 'wrtcommander'), ['gr', 'gw', 'gx'], [0o040, 0o020, 0o010]),
				row(_('Others', 'wrtcommander'), ['or', 'ow', 'ox'], [0o004, 0o002, 0o001])
			]);
			recompute();

			var uidInput = E('input', { type: 'text', class: 'cbi-input-text fx-num', value: st.uid });
			var gidInput = E('input', { type: 'text', class: 'cbi-input-text fx-num', value: st.gid });
			[uidInput, gidInput].forEach(function (i) {
				i.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
			});

			ui.showModal(_('Permissions', 'wrtcommander') + ' — ' + entry.name, [
				table,
				preview,
				E('div', { class: 'fx-owner-row' }, [
					E('label', {}, _('User ID', 'wrtcommander')), uidInput,
					E('label', {}, _('Group ID', 'wrtcommander')), gidInput
				]),
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
					' ',
					E('button', {
						class: 'btn cbi-button-action',
						click: function () {
							var mode = recompute();
							var ops = [callChmod(entry.path, mode)];
							var u = parseInt(uidInput.value, 10);
							var g = parseInt(gidInput.value, 10);
							if (u !== st.uid || g !== st.gid)
								ops.push(callChown(entry.path, isNaN(u) ? -1 : u, isNaN(g) ? -1 : g));
							ui.hideModal();
							Promise.all(ops).then(function (rs) {
								var bad = rs.filter(function (r) { return !r || r.ok === false; });
								if (bad.length) notifyError(bad[0], _('Cannot change permissions', 'wrtcommander'));
								else notifyOk(_('Permissions updated', 'wrtcommander'));
								self.loadPane(id, true);
							});
						}
					}, _('Apply', 'wrtcommander'))
				])
			]);
		});
	},

	/* ------------------------------------------------------- preview */

	previewEntry: function (entry) {
		var self = this;
		callRead(entry.path, 'preview').then(function (r) {
			if (!r || r.ok === false) {
				if (r && r.error && r.error.code === 'EFBIG')
					return self.previewTooLarge(entry);
				return notifyError(r, _('Cannot open file', 'wrtcommander'));
			}
			if (r.is_binary) {
				if (classify(entry) === 'image') return self.previewImage(entry);
				return self.previewBinary(entry);
			}
			ui.showModal(entry.path, [
				E('pre', { class: 'fx-pre' }, b64DecodeUtf8(r.data)),
				r.truncated ? E('p', { class: 'fx-warn' },
					_('Preview truncated, the file is %s.', 'wrtcommander').format(fmtSize(r.size))) : '',
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: function () { self.downloadEntry(entry); } }, _('Download', 'wrtcommander')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: function () { ui.hideModal(); self.editEntry(entry); } }, _('Edit', 'wrtcommander')),
					' ',
					E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander'))
				])
			], 'fx-modal-wide');
		});
	},

	previewImage: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('div', { class: 'fx-img-wrap' }, E('img', { src: this.downloadUrl(entry.path) })),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: function () { self.downloadEntry(entry); } }, _('Download', 'wrtcommander')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander'))
			])
		], 'fx-modal-wide');
	},

	previewBinary: function (entry) {
		var self = this;
		ui.showModal(entry.path, [
			E('p', {}, _('This is a binary file and cannot be shown as text.', 'wrtcommander')),
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn cbi-button-action', click: function () { self.downloadEntry(entry); } }, _('Download', 'wrtcommander')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander'))
			])
		]);
	},

	previewTooLarge: function (entry) {
		var self = this;
		function part(mode, label) {
			return E('button', {
				class: 'btn', click: function () {
					callRead(entry.path, mode).then(function (r) {
						if (!r || r.ok === false) return notifyError(r, _('Cannot open file', 'wrtcommander'));
						ui.showModal(entry.path + ' — ' + label, [
							E('pre', { class: 'fx-pre' }, b64DecodeUtf8(r.data)),
							E('div', { class: 'right fx-modal-actions' },
								E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander')))
						], 'fx-modal-wide');
					});
				}
			}, label);
		}
		ui.showModal(entry.path, [
			E('p', {}, _('The file is too large to show in full.', 'wrtcommander')),
			E('div', { class: 'right fx-modal-actions' }, [
				part('head', _('First part', 'wrtcommander')), ' ',
				part('tail', _('Last part', 'wrtcommander')), ' ',
				E('button', { class: 'btn cbi-button-action', click: function () { self.downloadEntry(entry); } }, _('Download', 'wrtcommander')),
				' ',
				E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander'))
			])
		]);
	},

	/* -------------------------------------------------------- editor */

	editEntry: function (entry) {
		var self = this;
		callRead(entry.path, 'edit').then(function (r) {
			if (!r || r.ok === false) {
				if (r && r.error && r.error.code === 'EFBIG')
					return ui.addNotification(null, E('p', {}, _('The file is too large to edit. Download it instead.', 'wrtcommander')), 'warning');
				if (r && r.error && r.error.code === 'EINVAL')
					return ui.addNotification(null, E('p', {}, _('This does not look like a text file.', 'wrtcommander')), 'warning');
				return notifyError(r, _('Cannot open file', 'wrtcommander'));
			}

			var textarea = E('textarea', {
				class: 'fx-editor' + (self.wrapEditor ? '' : ' fx-editor-nowrap'),
				spellcheck: 'false',
				/* the attribute is what actually stops the browser from
				   wrapping; the class only styles the overflow */
				wrap: self.wrapEditor ? 'soft' : 'off'
			}, b64DecodeUtf8(r.data));
			var dirty = false;
			var mtime = r.mtime, size = r.size;

			textarea.addEventListener('input', function () { dirty = true; });
			textarea.addEventListener('keydown', function (ev) {
				ev.stopPropagation();
				if ((ev.ctrlKey || ev.metaKey) && (ev.key === 's' || ev.key === 'S')) {
					ev.preventDefault();
					save(false);
				}
			});

			function save(force) {
				var content = textarea.value;
				callWrite(entry.path, b64EncodeUtf8(content), 'base64', mtime, size, !!force).then(function (w) {
					if (!w || w.ok === false) {
						if (w && w.error && w.error.code === 'ECONFLICT') {
							ui.showModal(_('File changed on disk', 'wrtcommander'), [
								E('p', {}, _('This file was modified by something else after you opened it. Overwrite those changes?', 'wrtcommander')),
								E('div', { class: 'right fx-modal-actions' }, [
									E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
									' ',
									E('button', {
										class: 'btn cbi-button-negative',
										click: function () { ui.hideModal(); save(true); }
									}, _('Overwrite', 'wrtcommander'))
								])
							]);
							return;
						}
						return notifyError(w, _('Cannot save file', 'wrtcommander'));
					}
					dirty = false;
					mtime = w.mtime;
					size = w.size;
					notifyOk(_('Saved', 'wrtcommander'));
				});
			}

			function close() {
				if (!dirty) { ui.hideModal(); return; }
				ui.showModal(_('Unsaved changes', 'wrtcommander'), [
					E('p', {}, _('You have unsaved changes. Discard them?', 'wrtcommander')),
					E('div', { class: 'right fx-modal-actions' }, [
						E('button', { class: 'btn', click: function () { ui.hideModal(); self.editEntry(entry); } }, _('Keep editing', 'wrtcommander')),
						' ',
						E('button', { class: 'btn cbi-button-negative', click: ui.hideModal }, _('Discard', 'wrtcommander'))
					])
				]);
			}

			ui.showModal(entry.path, [
				textarea,
				E('div', { class: 'fx-editor-hint' }, _('Press Ctrl+S to save.', 'wrtcommander')),
				E('div', { class: 'right fx-modal-actions' }, [
					E('button', { class: 'btn', click: close }, _('Cancel', 'wrtcommander')),
					' ',
					E('button', { class: 'btn cbi-button-action', click: function () { save(false); } }, _('Save', 'wrtcommander'))
				])
			], 'fx-modal-wide');

			textarea.focus();
		});
	},

	/* ------------------------------------------------------ download */

	downloadUrl: function (path) {
		return L.url('admin', 'services', 'wrtcommander', 'download') + '?path=' + encodeURIComponent(path);
	},

	downloadEntry: function (entry) {
		var a = E('a', { href: this.downloadUrl(entry.path), download: entry.name, style: 'display:none' });
		document.body.appendChild(a);
		a.click();
		window.setTimeout(function () { a.remove(); }, 1000);
	},

	/* -------------------------------------------------------- upload */

	actUpload: function () {
		this.pickAndUpload(this.active, false);
	},

	/* A folder upload is the same upload, run once per file, with the
	   directories created first. It adds nothing to the router: the
	   relative paths the browser hands over are turned into absolute
	   destinations here, and each one then goes through a door that was
	   already there - mkdir on the ubus object, and the upload endpoint -
	   both of which put the path through canon()/canon_path() before
	   touching the filesystem. So an upload still cannot leave the
	   allowed root, whatever this code computes. */
	actUploadFolder: function () {
		this.pickAndUpload(this.active, true);
	},

	/* Picking a directory needs `webkitdirectory`, which no mobile browser
	   implements - and the property alone does not tell you that, because
	   it sits in the IDL of every Chromium build including Android, where
	   choosing a folder simply does not happen. There is no honest feature
	   test for it, so a touch-primary device is treated as not having it
	   and is offered the ZIP route instead, which works everywhere. */
	folderPickerSupported: function () {
		if (!('webkitdirectory' in document.createElement('input')))
			return false;
		if (window.matchMedia &&
		    window.matchMedia('(pointer: coarse)').matches &&
		    !window.matchMedia('(any-hover: hover)').matches)
			return false;
		return true;
	},

	pickAndUpload: function (id, wantFolder) {
		var self = this;
		var dest = this.panes[id].path;

		if (wantFolder && !this.folderPickerSupported()) {
			ui.addNotification(null, E('p', {},
				_('This browser cannot pick a folder. Use "Upload folder from a ZIP" instead - that works everywhere, phones included.', 'wrtcommander')), 'warning');
			return;
		}

		var attrs = { type: 'file', multiple: true, style: 'display:none' };
		if (wantFolder) {
			attrs.webkitdirectory = '';
			attrs.directory = '';
		}
		var input = E('input', attrs);
		document.body.appendChild(input);
		input.addEventListener('change', function () {
			var files = Array.prototype.slice.call(input.files || []);
			input.remove();
			if (!files.length)
				return;
			if (wantFolder)
				self.uploadTree(files, dest, id);
			else
				self.uploadFiles(files.map(function (f) {
					return { file: f, dest: dest, label: f.name };
				}), dest, id, []);
		});
		input.click();
	},

	/* The route that works on a phone.

	   No mobile browser can pick a folder, but every one of them can pick
	   a .zip - and both iOS Files and most Android file managers have a
	   "Compress" that makes one. The archive is read here in the browser
	   and turned into exactly the same upload as a picked folder: the
	   directories first, then one POST per file. The router is not told
	   an archive was involved and needs no unzip of its own, which is
	   also why Zip Slip has nowhere to land - every entry goes through
	   canon_path() as an ordinary upload. */
	actUploadZip: function () {
		var self = this;
		var id = this.active;
		var dest = this.panes[id].path;

		var input = E('input', {
			type: 'file',
			accept: '.zip,application/zip,application/x-zip-compressed',
			style: 'display:none'
		});
		document.body.appendChild(input);
		input.addEventListener('change', function () {
			var file = (input.files || [])[0];
			input.remove();
			if (file) self.openZip(file, dest, id);
		});
		input.click();
	},

	openZip: function (file, dest, paneId) {
		var self = this;

		ui.showModal(_('Upload folder from a ZIP', 'wrtcommander'), [
			E('p', {}, _('Reading %s…', 'wrtcommander').format(file.name))
		]);

		zipList(file).then(function (entries) {
			self.confirmZip(file, entries, dest, paneId);
		}, function (err) {
			ui.hideModal();
			ui.addNotification(null, E('p', {},
				(typeof err === 'string') ? err
					: _('Cannot read the archive.', 'wrtcommander')), 'error');
		});
	},

	/* Turn the entry list into directories and upload items, then say what
	   is about to happen before anything is written. An archive can hold
	   several hundred files and the destination is whichever directory the
	   panel happens to be showing, so this is worth confirming. */
	confirmZip: function (file, entries, dest, paneId) {
		var self = this;
		var items = [], dirs = {}, skipped = 0;
		var canInflate = zipInflateAvailable();
		var needInflate = false;

		function segments(name) {
			/* some archives use a backslash as the separator; the router
			   strips both from a filename anyway, so split on both here
			   rather than letting one become part of a name */
			var parts = name.split(/[/\\]/);
			var bad = parts.some(function (seg, i) {
				if (seg === '' && i === parts.length - 1)
					return false;               /* trailing "/" marks a directory */
				return seg === '' || seg === '.' || seg === '..' || seg.indexOf('\u0000') >= 0;
			});
			return bad ? null : parts;
		}

		function addDirs(parts) {
			var dir = dest;
			parts.forEach(function (seg) {
				dir = (dir === '/') ? ('/' + seg) : (dir + '/' + seg);
				dirs[dir] = true;
			});
			return dir;
		}

		entries.forEach(function (e) {
			var parts = segments(e.name);
			if (!parts) { skipped++; return; }

			var isDir = (parts[parts.length - 1] === '');
			if (isDir) {
				parts.pop();
				if (parts.length) addDirs(parts);
				return;                          /* an empty folder still gets made */
			}
			if (e.encrypted || (e.method !== 0 && e.method !== 8)) { skipped++; return; }
			if (e.method === 8) needInflate = true;

			var name = parts.pop();
			var dir = parts.length ? addDirs(parts) : dest;
			items.push({
				dest: dir,
				label: e.name,
				load: function () { return zipEntryFile(file, e, name); }
			});
		});

		ui.hideModal();

		if (needInflate && !canInflate) {
			ui.addNotification(null, E('p', {},
				_('This browser cannot unpack a compressed archive. Only a ZIP stored without compression can be used here.', 'wrtcommander')), 'error');
			return;
		}
		if (!items.length && !Object.keys(dirs).length) {
			ui.addNotification(null, E('p', {},
				_('The archive has nothing that can be uploaded.', 'wrtcommander')), 'warning');
			return;
		}

		var dirList = Object.keys(dirs).sort(function (a, b) {
			var d = a.split('/').length - b.split('/').length;
			return d !== 0 ? d : (a < b ? -1 : 1);
		});

		ui.showModal(_('Upload folder from a ZIP', 'wrtcommander'), [
			E('p', {}, file.name),
			E('p', {}, _('Files: %d, folders: %d', 'wrtcommander').format(items.length, dirList.length)),
			E('p', { class: 'fx-up-dest' }, _('Destination: %s', 'wrtcommander').format(dest)),
			skipped ? E('p', { class: 'fx-warn' },
				N_(skipped, 'Skipping %d entry that cannot be unpacked.',
					'Skipping %d entries that cannot be unpacked.', 'wrtcommander').format(skipped)) : '',
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: ui.hideModal }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', {
					class: 'btn cbi-button-action',
					click: function () {
						ui.hideModal();
						self.uploadFiles(items, dest, paneId, dirList);
					}
				}, _('Upload', 'wrtcommander'))
			])
		]);
	},

	/* The browser hands over a flat list of files, each carrying the path
	   it had inside the picked folder. Turn that into the directories that
	   have to exist and a destination for every file.

	   A segment that is empty, "." or ".." is refused and the file is
	   dropped with a note. Browsers do not produce those, so this is about
	   not passing on something unexpected - it is not the permission
	   check, which is on the router and applies to every path regardless.

	   Empty directories do not survive the trip: a directory input reports
	   files, so a folder with nothing in it is not in the list and is not
	   created. */
	uploadTree: function (files, dest, paneId) {
		var items = [], dirs = {}, skipped = 0;

		files.forEach(function (f) {
			var rel = f.webkitRelativePath || f.name;
			var parts = rel.split('/');
			var bad = parts.some(function (seg) {
				return seg === '' || seg === '.' || seg === '..' || seg.indexOf('\u0000') >= 0;
			});
			if (bad) { skipped++; return; }

			parts.pop();
			var dir = dest;
			parts.forEach(function (seg) {
				dir = (dir === '/') ? ('/' + seg) : (dir + '/' + seg);
				dirs[dir] = true;
			});
			items.push({ file: f, dest: dir, label: rel });
		});

		if (skipped)
			ui.addNotification(null, E('p', {},
				N_(skipped, 'Skipped %d file with an unusable path.',
					'Skipped %d files with unusable paths.', 'wrtcommander').format(skipped)), 'warning');

		if (!items.length)
			return;

		/* shallowest first: mkdir makes one level at a time, so every
		   parent has to be created before its children */
		var dirList = Object.keys(dirs).sort(function (a, b) {
			var d = a.split('/').length - b.split('/').length;
			return d !== 0 ? d : (a < b ? -1 : 1);
		});

		this.uploadFiles(items, dest, paneId, dirList);
	},

	/* items: [{ file, dest, label }], dirList: absolute directories to
	   create first, shallowest first. A plain file upload passes an empty
	   dirList and one item per file, so both paths share this. */
	uploadFiles: function (items, dest, paneId, dirList) {
		var self = this;
		var total = items.length;
		var idx = 0;
		var done = 0;
		var cancelled = false;
		var xhr = null;
		var overwriteAll = false;
		var skipAll = false;

		var overall = E('div', { class: 'fx-up-overall' });
		var fileLabel = E('div', { class: 'fx-up-name' });
		var fill = E('div', { class: 'fx-bar-fill' });
		var destLine = E('div', { class: 'fx-up-dest' }, _('Destination: %s', 'wrtcommander').format(dest));

		function stop() {
			cancelled = true;
			if (xhr) xhr.abort();
			ui.hideModal();
			/* a cancelled tree leaves part of itself behind, so the panel
			   has to be re-read rather than left showing the old listing */
			self.loadPane(paneId, true);
		}

		ui.showModal(_('Uploading', 'wrtcommander'), [
			destLine, overall, fileLabel,
			E('div', { class: 'fx-bar' }, fill),
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn', click: stop }, _('Cancel', 'wrtcommander')))
		]);

		/* An item is either a File already (a picked file) or a loader that
		   produces one (a ZIP entry, unpacked when its turn comes so a big
		   archive never has to be held in memory all at once). */
		function post(item, overwrite, onDone) {
			var pending = item.file ? Promise.resolve(item.file) : item.load();
			pending.then(function (file) { send_it(file); },
				/* hand the reason back the same shape the endpoint uses, so
				   the one reporting path below says why rather than
				   "Upload failed" on top of a message already shown */
				function (err) {
					onDone(0, { ok: false, error: { code: 'EIO', message:
						(typeof err === 'string') ? err : _('Upload failed', 'wrtcommander') } });
				});

			function send_it(file) {
			var fd = new FormData();
			fd.append('file', file, file.name);
			xhr = new XMLHttpRequest();
			xhr.open('POST', L.url('admin', 'services', 'wrtcommander', 'upload') +
				'?dest=' + encodeURIComponent(item.dest) + '&overwrite=' + (overwrite ? '1' : '0'));
			xhr.upload.addEventListener('progress', function (ev) {
				if (ev.lengthComputable)
					fill.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
			});
			xhr.onload = function () {
				var resp = null;
				try { resp = JSON.parse(xhr.responseText); } catch (e) { /* ignore */ }
				onDone(xhr.status, resp);
			};
			xhr.onerror = function () { onDone(0, null); };
			xhr.send(fd);
			}
		}

		function report(item, resp) {
			ui.addNotification(null, E('p', {},
				item.label + ': ' + errorMessage(resp, _('Upload failed', 'wrtcommander'))), 'error');
		}

		function finish() {
			ui.hideModal();
			if (done === total)
				notifyOk(N_(total, 'Uploaded %d file', 'Uploaded %d files', 'wrtcommander').format(total));
			else
				ui.addNotification(null, E('p', {},
					_('Uploaded %d of %d.', 'wrtcommander').format(done, total)), 'warning');
			self.loadPane(paneId, true);
		}

		function send(item, overwrite) {
			post(item, overwrite, function (status, resp) {
				if (cancelled) return;
				if (status === 200 && resp && resp.ok) { done++; idx++; next(); return; }
				if (resp && resp.error && resp.error.code === 'EEXIST' && !overwrite) {
					if (skipAll) { idx++; next(); return; }
					if (overwriteAll) { send(item, true); return; }
					self.confirmUploadOverwrite(item.label, total - idx > 1, function (what, forAll) {
						if (what === 'cancel') { stop(); return; }
						if (what === 'skip') {
							if (forAll) skipAll = true;
							idx++; next();
							return;
						}
						if (forAll) overwriteAll = true;
						send(item, true);
					});
					return;
				}
				report(item, resp);
				idx++;
				next();
			});
		}

		function next() {
			if (cancelled) return;
			if (idx >= total) { finish(); return; }
			var item = items[idx];
			fileLabel.textContent = item.label;
			overall.textContent = _('File %d of %d', 'wrtcommander').format(idx + 1, total);
			fill.style.width = '0%';
			send(item, overwriteAll);
		}

		/* Directories first. An EEXIST here is the ordinary case - part of
		   the tree is already on the router - and is not an error. */
		function makeDirs(i) {
			if (cancelled) return;
			if (i >= dirList.length) { next(); return; }
			overall.textContent = _('Creating folders: %d of %d', 'wrtcommander').format(i + 1, dirList.length);
			fileLabel.textContent = dirList[i];
			fill.style.width = '0%';
			callMkdir(dirList[i]).then(function (r) {
				if (cancelled) return;
				if (r && r.ok === false && !(r.error && r.error.code === 'EEXIST')) {
					ui.hideModal();
					notifyError(r, _('Cannot create folder', 'wrtcommander'));
					self.loadPane(paneId, true);
					return;
				}
				makeDirs(i + 1);
			});
		}

		if (dirList && dirList.length)
			makeDirs(0);
		else
			next();
	},

	/* Overwrite prompt for uploads. Separate from confirmOverwrite(),
	   which copy and move use for a whole batch at once: here the files
	   arrive one at a time, so the answer needs a "and the rest of them
	   too" - otherwise re-uploading a folder asks once per file.
	   `onAnswer(what, forAll)` with what = cancel | skip | overwrite. */
	confirmUploadOverwrite: function (label, more, onAnswer) {
		var all = E('input', { type: 'checkbox' });

		function answer(what) {
			return function () { ui.hideModal(); onAnswer(what, all.checked); };
		}

		ui.showModal(_('File already exists', 'wrtcommander'), [
			E('p', {}, _('"%s" already exists at the destination.', 'wrtcommander').format(label)),
			more ? E('label', { class: 'fx-set-row' }, [
				all,
				E('span', { class: 'fx-set-text' },
					E('span', { class: 'fx-set-label' }, _('Apply to the rest', 'wrtcommander')))
			]) : '',
			E('div', { class: 'right fx-modal-actions' }, [
				E('button', { class: 'btn', click: answer('cancel') }, _('Cancel', 'wrtcommander')),
				' ',
				E('button', { class: 'btn', click: answer('skip') }, _('Skip', 'wrtcommander')),
				' ',
				E('button', { class: 'btn cbi-button-negative', click: answer('overwrite') },
					_('Overwrite', 'wrtcommander'))
			])
		]);
	},

	/* -------------------------------------------------------- search */

	actSearch: function () {
		var self = this;
		var id = this.active;
		var base = this.panes[id].path;

		var input = E('input', { type: 'text', class: 'cbi-input-text fx-full', placeholder: _('Part of a file name', 'wrtcommander') });
		var recursive = E('input', { type: 'checkbox' });
		var results = E('div', { class: 'fx-search-results' });
		var timer = null;

		input.addEventListener('keydown', function (ev) {
			ev.stopPropagation();
			if (ev.key === 'Enter') { window.clearTimeout(timer); run(); }
		});
		input.addEventListener('input', function () {
			window.clearTimeout(timer);
			timer = window.setTimeout(run, 400);
		});
		recursive.addEventListener('change', run);

		function run() {
			var q = input.value;
			if (!q) { results.innerHTML = ''; return; }
			dom.content(results, E('div', { class: 'fx-loading' }, _('Searching…', 'wrtcommander')));
			callSearch(base, q, recursive.checked, 500).then(function (r) {
				if (!r || r.ok === false) {
					dom.content(results, E('p', { class: 'alert-message warning' },
						errorMessage(r, _('Search failed', 'wrtcommander'))));
					return;
				}
				if (!r.results.length) {
					dom.content(results, E('div', { class: 'fx-empty' }, _('Nothing found', 'wrtcommander')));
					return;
				}
				var rows = r.results.map(function (entry) {
					return E('div', {
						class: 'fx-search-row',
						click: function () {
							ui.hideModal();
							var dir = (entry.type === 'directory') ? entry.path : dirName(entry.path);
							self.navigate(id, dir);
						}
					}, [
						E('span', { class: 'fx-ico' }, iconFor(entry, classify(entry))),
						E('span', { class: 'fx-search-name' }, entry.name),
						E('span', { class: 'fx-search-path' }, dirName(entry.path))
					]);
				});
				if (r.truncated)
					rows.push(E('div', { class: 'fx-warn' },
						_('Too many matches, only the first %d are shown.', 'wrtcommander').format(r.results.length)));
				dom.content(results, rows);
			});
		}

		ui.showModal(_('Search', 'wrtcommander'), [
			E('p', {}, _('Searching in: %s', 'wrtcommander').format(base)),
			input,
			E('label', { class: 'fx-check-row' }, [recursive, ' ', _('Search inside subfolders', 'wrtcommander')]),
			results,
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn', click: ui.hideModal }, _('Close', 'wrtcommander')))
		], 'fx-modal-wide');

		input.focus();
	},

	/* ------------------------------------------------------ settings */

	/* Deliberately short. A file manager's settings dialog is where
	   options accumulate; these are the ones that change how the list
	   itself reads or where the panels start, and each is a single
	   switch. Anything that belongs to one file (permissions, say) lives
	   on that file, not here. */
	actSettings: function () {
		var self = this;

		/* `redraw` is off for options that only take effect the next time
		   something is opened, so the dialog does not repaint the panels
		   for no reason. */
		function check(label, hint, prop, key, redraw) {
			var cb = E('input', { type: 'checkbox' });
			cb.checked = self[prop];
			cb.addEventListener('change', function () {
				self[prop] = cb.checked;
				lsSet(key, cb.checked);
				if (redraw) {
					self.renderBody('left');
					self.renderBody('right');
					self.renderFoot('left');
					self.renderFoot('right');
				}
			});
			return E('label', { class: 'fx-set-row' }, [
				cb,
				E('span', { class: 'fx-set-text' }, [
					E('span', { class: 'fx-set-label' }, label),
					hint ? E('span', { class: 'fx-set-hint' }, hint) : ''
				])
			]);
		}

		function group(title, kids) {
			return E('div', { class: 'fx-set-group' },
				[E('div', { class: 'fx-set-group-title' }, title)].concat(kids));
		}

		ui.showModal(_('Settings', 'wrtcommander'), [
			E('div', { class: 'fx-settings' }, [
				group(_('Appearance', 'wrtcommander'), [
					check(_('Show hidden files', 'wrtcommander'),
						_('Files and folders whose name starts with a dot.', 'wrtcommander'),
						'showHidden', 'showHidden', true),
					check(_('Folders first', 'wrtcommander'),
						_('Sort folders above files, whatever the sort column.', 'wrtcommander'),
						'dirsFirst', 'dirsFirst', true)
				]),
				group(_('Behaviour', 'wrtcommander'), [
					check(_('Open with a single click', 'wrtcommander'),
						_('One click or tap opens a folder or a file. With this off it takes two, as on a desktop. Ctrl-click marks a row either way.', 'wrtcommander'),
						'singleClick', 'singleClick', false)
				]),
				group(_('Panels', 'wrtcommander'), [
					check(_('Remember panel paths', 'wrtcommander'),
						_('Open both panels where you left them last time.', 'wrtcommander'),
						'rememberPaths', 'rememberPaths', false),
					E('div', { class: 'fx-set-row fx-set-row-action' }, [
						E('span', { class: 'fx-set-text' }, [
							E('span', { class: 'fx-set-label' }, _('Column widths', 'wrtcommander')),
							E('span', { class: 'fx-set-hint' },
								_('Drag the edge of a column header to change it.', 'wrtcommander'))
						]),
						E('button', {
							class: 'btn cbi-button',
							click: function () {
								for (var k in COLUMNS)
									self.resetColumnWidth(k);
							}
						}, _('Reset', 'wrtcommander'))
					])
				]),
				group(_('Editor', 'wrtcommander'), [
					check(_('Wrap long lines', 'wrtcommander'),
						_('Applies the next time a file is opened for editing.', 'wrtcommander'),
						'wrapEditor', 'wrapEditor', false)
				])
			]),
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Close', 'wrtcommander')))
		]);
	},

	/* A two-column grid rather than a full-width table: the keys are
	   right-aligned against the middle gutter and the descriptions start
	   just after it, and the whole block is only as wide as its content
	   and centred in the dialog. The old table stretched to the full
	   modal width with a 40% key column, which left a stripe of empty
	   space between every key and the thing it does. */
	actShortcuts: function () {
		var rows = [];

		function group(title) {
			rows.push(E('div', { class: 'fx-keys-group' }, title));
		}

		function row(keys, what) {
			rows.push(E('div', { class: 'fx-keys-k' },
				keys.map(function (k) { return E('kbd', {}, k); })));
			rows.push(E('div', { class: 'fx-keys-v' }, what));
		}

		group(_('Navigation', 'wrtcommander'));
		row(['Tab'], _('Switch panel', 'wrtcommander'));
		row(['Enter'], _('Open', 'wrtcommander'));
		row(['Backspace'], _('Go up one level', 'wrtcommander'));
		row(['Ctrl', 'R'], _('Refresh the active panel', 'wrtcommander'));

		group(_('Selection', 'wrtcommander'));
		row(['Insert', 'Space'], _('Select or unselect', 'wrtcommander'));
		row(['Ctrl', 'A'], _('Select all', 'wrtcommander'));
		row(['Ctrl', _('Click', 'wrtcommander')], _('Select or unselect without opening', 'wrtcommander'));
		row(['Ctrl', 'Space'], _('Calculate folder size', 'wrtcommander'));

		group(_('File actions', 'wrtcommander'));
		row(['F2'], _('Rename', 'wrtcommander'));
		row(['F3'], _('View', 'wrtcommander'));
		row(['F4'], _('Edit', 'wrtcommander'));
		row(['F5'], _('Copy', 'wrtcommander'));
		row(['F6'], _('Move', 'wrtcommander'));
		row(['F7'], _('New folder', 'wrtcommander'));
		row(['F8', 'Delete'], _('Delete', 'wrtcommander'));
		row(['Ctrl', 'S'], _('Save in the editor', 'wrtcommander'));

		ui.showModal(_('Keyboard shortcuts', 'wrtcommander'), [
			E('div', { class: 'fx-keys' }, rows),
			E('p', { class: 'fx-help fx-help-centred' },
				_('Shortcuts work while the file list has focus, not while typing in a field.', 'wrtcommander')),
			E('div', { class: 'right fx-modal-actions' },
				E('button', { class: 'btn cbi-button', click: ui.hideModal }, _('Close', 'wrtcommander')))
		]);
	}

});
