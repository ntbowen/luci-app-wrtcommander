--[[
Wrt Commander - HTTP streaming controller

The JS view and every regular filesystem operation (list, stat, mkdir,
rename, copy, move, delete, chmod, chown, search, disk_info, small
file read/write) go through the "luci.wrtcommander" ubus/rpcd object
(see /usr/share/rpcd/ucode/wrtcommander.uc).

Arbitrarily large file upload and download cannot reasonably go through
ubus/JSON-RPC (no streaming, base64 overhead, message size limits), so
those two operations use plain HTTP via this controller instead. This
is the one place in the application that depends on luci-lua-runtime.

canon_path() below is a Lua re-implementation of the same canonical
path validation pipeline used by the ucode backend (normalize -> resolve
-> symlink handling -> containment check against allowed_root). Keep the
two in sync if the policy ever changes.
--]]

module("luci.controller.wrtcommander", package.seeall)

function index()
	entry({"admin", "services", "wrtcommander", "upload"}, call("action_upload")).leaf = true
	entry({"admin", "services", "wrtcommander", "download"}, call("action_download")).leaf = true
end

-- ------------------------------------------------------------------
-- shared helpers
-- ------------------------------------------------------------------

local function get_allowed_root()
	local uci = require "luci.model.uci".cursor()
	local root = uci:get("wrtcommander", "main", "allowed_root")
	if not root or root == "" then
		root = "/"
	end
	if #root > 1 and root:sub(-1) == "/" then
		root = root:sub(1, -2)
	end
	return root
end

local function fm_enabled()
	local uci = require "luci.model.uci".cursor()
	local v = uci:get("wrtcommander", "main", "enabled")
	return v == nil or v == "1"
end

local function in_root(p, root)
	if root == "/" then
		return true
	end
	if p == root then
		return true
	end
	return (p .. "/"):sub(1, #root + 1) == (root .. "/")
end

-- Canonicalise a client-supplied path: lexical normalisation, containment
-- check against allowed_root, then symlink resolution via realpath and a
-- second containment check on the resolved path. Mirrors canon() in the
-- ucode backend. Returns real_path, nil on success or nil, message on error.
local function canon_path(rawpath, must_exist)
	local fs = require "nixio.fs"

	-- distinct messages on purpose, so a rejection that reaches the UI
	-- names the rule that fired instead of a catch-all "Invalid path"
	if type(rawpath) ~= "string" then
		return nil, "Path is not a string"
	end
	if rawpath == "" then
		return nil, "Path is empty"
	end
	if rawpath:find("\0", 1, true) then
		return nil, "Path contains a NUL byte"
	end
	if rawpath:sub(1, 1) ~= "/" then
		return nil, "Path must be absolute"
	end

	local stack = {}
	for part in rawpath:gmatch("[^/]+") do
		if part == "." then
			-- skip
		elseif part == ".." then
			if #stack > 0 then
				table.remove(stack)
			end
		else
			table.insert(stack, part)
		end
	end
	local normalized = "/" .. table.concat(stack, "/")

	local root = get_allowed_root()
	if not in_root(normalized, root) then
		return nil, "Path is outside the allowed root"
	end

	local real
	if fs.access(normalized) then
		real = fs.realpath(normalized)
		if not real then
			return nil, "Failed to resolve path"
		end
	else
		if must_exist then
			return nil, "No such file or directory"
		end
		local parent = normalized:match("^(.*)/[^/]+$")
		if not parent or parent == "" then
			parent = "/"
		end
		if not fs.access(parent) then
			return nil, "Parent directory does not exist"
		end
		local realparent = fs.realpath(parent)
		if not realparent then
			return nil, "Failed to resolve parent path"
		end
		if #realparent > 1 and realparent:sub(-1) == "/" then
			realparent = realparent:sub(1, -2)
		end
		local base = normalized:match("([^/]+)$") or ""
		real = (realparent == "/") and ("/" .. base) or (realparent .. "/" .. base)
	end

	if not in_root(real, root) then
		return nil, "Path escapes the allowed root via a symlink"
	end

	return real
end

-- Ask rpcd whether the current LuCI session has the given ubus ACL
-- permission. Root/admin sessions always pass (rpcd's default root
-- login grants every scope), non-admin sessions are gated for real.
local function session_has_access(object, func)
	local ok, ubus = pcall(require, "ubus")
	if not ok then
		return false
	end
	local conn = ubus.connect()
	if not conn then
		return false
	end
	local sid = luci.dispatcher.context.authsession
	local res = conn:call("session", "access", {
		ubus_rpc_session = sid,
		scope = "ubus",
		object = object,
		["function"] = func,
	})
	conn:close()
	return res ~= nil and res.access == true
end

local function basename_of(p)
	return p:match("([^/]+)$") or p
end

-- strip bytes that would break an HTTP header value (CR/LF/quote/etc.)
local function header_ascii_safe(name)
	local safe = name:gsub('[%c"\\]', "_")
	safe = safe:gsub("[\128-\255]", "_")
	return safe
end

local function url_encode(s)
	return (s:gsub('[%c"\\]', "_"):gsub("[^%w%-%_%.%~]", function(c)
		return string.format("%%%02X", string.byte(c))
	end))
end

local function send_json_error(http, status, code, message)
	http.status(status, "Error")
	http.prepare_content("application/json")
	http.write_json({ ok = false, error = { code = code, message = message } })
end

-- ------------------------------------------------------------------
-- download: GET /admin/services/wrtcommander/download?path=/etc/config/network
-- ------------------------------------------------------------------

function action_download()
	local http = luci.http
	local fs = require "nixio.fs"

	if not fm_enabled() then
		return send_json_error(http, 403, "EACCES", "Wrt Commander is disabled")
	end
	if not session_has_access("luci.wrtcommander", "list") then
		return send_json_error(http, 403, "EACCES", "Permission denied")
	end

	local rawpath = http.formvalue("path")
	local real, err = canon_path(rawpath, true)
	if not real then
		return send_json_error(http, 400, "EINVAL", err or "Invalid path")
	end

	local st = fs.stat(real)
	if not st then
		return send_json_error(http, 404, "ENOENT", "Not found")
	end
	if st.type == "dir" then
		return send_json_error(http, 400, "EISDIR", "Cannot download a directory")
	end
	if st.type ~= "reg" then
		return send_json_error(http, 400, "EINVAL", "Refusing to download a non-regular file")
	end

	local fh = io.open(real, "rb")
	if not fh then
		return send_json_error(http, 500, "EIO", "Cannot open file")
	end

	local raw_name = basename_of(real)

	http.status(200, "OK")
	http.header("Content-Type", "application/octet-stream")
	http.header("Content-Length", tostring(st.size))
	http.header("Cache-Control", "no-store")
	http.header("X-Content-Type-Options", "nosniff")
	http.header("Content-Disposition", string.format(
		'attachment; filename="%s"; filename*=UTF-8\'\'%s',
		header_ascii_safe(raw_name), url_encode(raw_name)))

	while true do
		local chunk = fh:read(65536)
		if not chunk or #chunk == 0 then
			break
		end
		http.write(chunk)
	end
	fh:close()
end

-- ------------------------------------------------------------------
-- upload: POST /admin/services/wrtcommander/upload?dest=/etc/config&overwrite=0
-- multipart/form-data body, file field(s) named "file"
-- ------------------------------------------------------------------

function action_upload()
	local http = luci.http
	local fs = require "nixio.fs"

	if not fm_enabled() then
		return send_json_error(http, 403, "EACCES", "Wrt Commander is disabled")
	end
	if not session_has_access("luci.wrtcommander", "write") then
		return send_json_error(http, 403, "EACCES", "Permission denied")
	end

	-- Read these with noparse=true. They arrive in the query string, which
	-- luci.http has already decoded into the parameter table when the
	-- request object was built, so they are available without touching the
	-- body. A plain formvalue() here would parse the multipart body
	-- *before* the file handler exists - see the handler below for what
	-- that costs.
	local dest_raw = http.formvalue("dest", true)
	local overwrite = http.formvalue("overwrite", true) == "1"

	local dest, derr = canon_path(dest_raw, true)
	if not dest then
		return send_json_error(http, 400, "EINVAL", derr or "Invalid destination")
	end
	local dst_stat = fs.stat(dest)
	if not dst_stat or dst_stat.type ~= "dir" then
		return send_json_error(http, 400, "ENOTDIR", "Destination is not a directory")
	end

	local upload_error = nil
	local out_fh = nil
	local out_path = nil
	local bytes_written = 0
	local final_name = nil

	-- `meta` is not only delivered once per part. luci.http has two paths:
	-- when the handler is installed before the body is parsed it streams,
	-- and `meta` comes once at the start of each part; but when the body
	-- was already parsed it replays the buffered upload and passes `meta`
	-- with *every* chunk. Treating each `meta` as a new part there meant
	-- reopening the target with "wb" on every chunk - truncating it - so
	-- the last call, the empty end-of-file one, left a 0-byte file, and
	-- the second chunk saw the file the first chunk had just created and
	-- reported EEXIST for a name that did not exist before the upload.
	--
	-- So a part is only opened once: `started` guards it, and a repeat of
	-- the same meta is ignored rather than treated as a new file.
	local started = false

	http.setfilehandler(function(meta, chunk, eof)
		if meta and not started and meta.file and meta.file ~= "" then
			started = true

			local safe_name = meta.file:match("([^/\\]+)$") or meta.file
			if safe_name == "" or safe_name == "." or safe_name == ".." then
				upload_error = { code = "EINVAL", message = "Invalid filename" }
				return
			end
			local target, terr = canon_path(dest .. "/" .. safe_name, false)
			if not target then
				upload_error = { code = "EINVAL", message = terr or "Invalid target path" }
				return
			end
			if fs.access(target) and not overwrite then
				upload_error = { code = "EEXIST", message = "File already exists: " .. safe_name }
				return
			end
			out_path = target
			final_name = safe_name
			out_fh = io.open(target, "wb")
			if not out_fh then
				upload_error = { code = "EACCES", message = "Cannot create destination file" }
				return
			end
			bytes_written = 0
		end

		if upload_error then
			return
		end
		if chunk and #chunk > 0 and out_fh then
			out_fh:write(chunk)
			bytes_written = bytes_written + #chunk
		end
		if eof and out_fh then
			out_fh:close()
			out_fh = nil
		end
	end)

	-- trigger the actual (now handler-aware) multipart parse
	http.formvalue()

	if out_fh then
		out_fh:close()
	end

	if upload_error then
		if out_path then
			fs.remove(out_path)
		end
		return send_json_error(http, 400, upload_error.code, upload_error.message)
	end

	if not out_path then
		return send_json_error(http, 400, "EINVAL", "No file received")
	end

	http.status(200, "OK")
	http.prepare_content("application/json")
	http.write_json({ ok = true, path = out_path, name = final_name, size = bytes_written })
end
