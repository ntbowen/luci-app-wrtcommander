-- Upload handler regression test. Runs anywhere Lua is available - it
-- needs no router, no HTTP and no rpcd, because it drives the handler
-- directly.
--
-- luci.http calls a file handler in two different ways. When the handler
-- is installed before the body is parsed it streams, and `meta` arrives
-- once at the start of a part. When the body was parsed first, it replays
-- the buffered upload and passes `meta` with *every* chunk
-- (luci-base/ucode/http.uc, setfilehandler()). The handler has to survive
-- both; getting the second one wrong produced 0-byte uploads and an
-- "already exists" prompt for names that did not exist.
--
-- The handler body is lifted out of the controller at run time, so this
-- test cannot drift away from the shipped code.
local TMP = "/tmp/wrtcommander-uploadtest"
os.execute("rm -rf " .. TMP .. " && mkdir -p " .. TMP)

local HERE = arg[0]:match("(.*)/") or "."
local CTRL = HERE .. "/../root/usr/lib/lua/luci/controller/wrtcommander.lua"

local src = assert(io.open(CTRL, "r"), "controller not found at " .. CTRL):read("*a")
local HANDLER_SRC = src:match("http%.setfilehandler%(function%(meta, chunk, eof%)\n(.-)\n\tend%)")
assert(HANDLER_SRC, "could not lift the file handler out of " .. CTRL)

local function readfile(p)
  local f = io.open(p, "rb"); if not f then return nil end
  local d = f:read("*a"); f:close(); return d
end

-- stand-ins for what the controller closes over
local function make(dest, overwrite)
  local env = {
    io = io, string = string, dest = dest, overwrite = overwrite,
    fs = { access = function(p)
             local f = io.open(p, "rb")
             if f then f:close(); return true end
             return false
           end },
    canon_path = function(p) return p end,
    upload_error = nil, out_fh = nil, out_path = nil,
    bytes_written = 0, final_name = nil, started = false,
  }
  local fn = assert(loadstring("local meta, chunk, eof = ...\n" .. HANDLER_SRC, "handler"))
  setfenv(fn, env)
  return env, fn
end

local fails = 0
local function check(name, got, want)
  local ok = (got == want)
  if not ok then fails = fails + 1 end
  print(string.format("  %s %-30s got=%-10s want=%s",
        ok and "ok  " or "FAIL", name, tostring(got), tostring(want)))
end

local DATA = string.rep("A", 700) .. string.rep("B", 700)   -- 1400 bytes

print("streaming path - meta once, then chunks")
do
  local env, h = make(TMP, false)
  h({ file = "note.txt" }, DATA:sub(1, 1024), false)
  h(nil, DATA:sub(1025), false)
  h(nil, "", true)
  if env.out_fh then env.out_fh:close() end
  check("bytes counted", env.bytes_written, #DATA)
  check("size on disk", #(readfile(TMP .. "/note.txt") or ""), #DATA)
  check("content intact", readfile(TMP .. "/note.txt") == DATA, true)
  check("no error", env.upload_error, nil)
end

print("\nreplay path - meta repeated with every chunk")
do
  local env, h = make(TMP, false)
  local meta = { file = "note2.txt" }
  h(meta, DATA:sub(1, 1024), false)
  h(meta, DATA:sub(1025), false)
  h(meta, "", true)
  if env.out_fh then env.out_fh:close() end
  check("bytes counted", env.bytes_written, #DATA)
  check("size on disk", #(readfile(TMP .. "/note2.txt") or ""), #DATA)
  check("no bogus EEXIST", env.upload_error, nil)
end

print("\nEEXIST only when the file really exists")
do
  local f = io.open(TMP .. "/dup.txt", "wb"); f:write("old"); f:close()
  local env, h = make(TMP, false)
  local meta = { file = "dup.txt" }
  h(meta, "new data", false)
  h(meta, "", true)
  check("code", env.upload_error and env.upload_error.code, "EEXIST")
  check("existing file untouched", readfile(TMP .. "/dup.txt"), "old")
end

print("\noverwrite=1 replaces it")
do
  local env, h = make(TMP, true)
  local meta = { file = "dup.txt" }
  h(meta, "new data", false)
  h(meta, "", true)
  if env.out_fh then env.out_fh:close() end
  check("no error", env.upload_error, nil)
  check("content replaced", readfile(TMP .. "/dup.txt"), "new data")
end

print(fails == 0 and "\nall passed" or ("\n" .. fails .. " FAILED"))
os.exit(fails == 0 and 0 or 1)
