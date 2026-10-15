#!/bin/sh
# Runs the upload handler regression test. Unlike the rest of the suite
# this one needs neither a router nor a running rpcd - it drives the
# handler directly - so it is also useful from a workstation.

cd "$(dirname "$0")" || exit 1

LUA="$(command -v lua5.1 || command -v luajit || command -v lua || true)"
if [ -z "$LUA" ]; then
	echo "SKIP: no lua interpreter found"
	exit 0
fi

echo "== Upload handler tests =="
"$LUA" upload-handler-test.lua
