#!/bin/sh
# Shared helpers for the Wrt Commander on-router test suite.
# Source this from the other tests/*.sh scripts:  . "$(dirname "$0")/lib.sh"
#
# These tests talk to the real ubus object, so they must run ON the
# router (or against a router reachable via `ubus -s`), after the
# package has been installed.

TESTFS="/tmp/wrtcommander-test"
PASS=0
FAIL=0

ubus_call() {
	# ubus_call <method> <json-args>
	ubus call luci.wrtcommander "$1" "$2" 2>&1
}

# top-level {"ok": true, ...} expected (list/stat/read/write/mkdir/
# create/rename/chmod/chown/search/disk_info, or the outer envelope of
# remove/copy/move)
expect_ok() {
	desc="$1"; out="$2"
	if echo "$out" | grep -qE '"ok":[[:space:]]*true'; then
		echo "PASS: $desc"
		PASS=$((PASS + 1))
	else
		echo "FAIL: $desc"
		echo "$out" | sed 's/^/    /'
		FAIL=$((FAIL + 1))
	fi
}

# top-level {"ok": false, "error": {"code": "..."}} expected
expect_fail() {
	desc="$1"; out="$2"; code="$3"
	if echo "$out" | grep -qE '"ok":[[:space:]]*false'; then
		if [ -n "$code" ] && ! echo "$out" | grep -qE "\"code\":[[:space:]]*\"$code\""; then
			echo "FAIL: $desc (expected error code $code)"
			echo "$out" | sed 's/^/    /'
			FAIL=$((FAIL + 1))
			return
		fi
		echo "PASS: $desc"
		PASS=$((PASS + 1))
	else
		echo "FAIL: $desc (expected a top-level failure)"
		echo "$out" | sed 's/^/    /'
		FAIL=$((FAIL + 1))
	fi
}

# remove/copy/move always return {"ok": true, "results": [...]}, with
# success/failure recorded per item - use these two instead of
# expect_ok/expect_fail for those three methods.
expect_bulk_all_ok() {
	desc="$1"; out="$2"
	if echo "$out" | grep -qE '"ok":[[:space:]]*false'; then
		echo "FAIL: $desc"
		echo "$out" | sed 's/^/    /'
		FAIL=$((FAIL + 1))
	else
		echo "PASS: $desc"
		PASS=$((PASS + 1))
	fi
}

expect_bulk_item_fail() {
	desc="$1"; out="$2"; code="$3"
	if echo "$out" | grep -qE '"ok":[[:space:]]*false'; then
		if [ -n "$code" ] && ! echo "$out" | grep -qE "\"code\":[[:space:]]*\"$code\""; then
			echo "FAIL: $desc (expected error code $code)"
			echo "$out" | sed 's/^/    /'
			FAIL=$((FAIL + 1))
			return
		fi
		echo "PASS: $desc"
		PASS=$((PASS + 1))
	else
		echo "FAIL: $desc (expected at least one failed item)"
		echo "$out" | sed 's/^/    /'
		FAIL=$((FAIL + 1))
	fi
}

summary() {
	echo
	echo "== $PASS passed, $FAIL failed =="
	[ "$FAIL" -eq 0 ]
}
