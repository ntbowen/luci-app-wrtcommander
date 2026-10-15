#!/bin/sh
# Runs the full Wrt Commander on-router test suite in order.
# Run this ON the router, as root, after the package is installed.
#
#   sh run-all.sh
#   ROUTER_PASS=yourpass sh run-all.sh      # if HTTP tests need a real login password
#
# Exits non-zero if any stage reports a failure.

set -e
cd "$(dirname "$0")"

OVERALL=0

run_stage() {
	echo
	echo "############################################################"
	echo "# $1"
	echo "############################################################"
	if sh "$1"; then
		echo ">>> $1: OK"
	else
		echo ">>> $1: FAILURES"
		OVERALL=1
	fi
}

echo "Wrt Commander - full on-router test suite"
echo "Checking prerequisites..."
command -v ubus >/dev/null 2>&1 || { echo "ERROR: ubus not found - run this on the router" >&2; exit 1; }
ubus list 2>/dev/null | grep -qx 'luci.wrtcommander' || {
	echo "ERROR: luci.wrtcommander is not registered on ubus - install the package first." >&2
	exit 1
}

sh make-testfs.sh

run_stage upload-handler-tests.sh
run_stage canon-path-tests.sh
run_stage ui-click-tests.sh
run_stage fs-tests.sh
run_stage dirsize-tests.sh
run_stage security-tests.sh
run_stage editor-tests.sh

if command -v curl >/dev/null 2>&1; then
	run_stage upload-tests.sh
	run_stage download-tests.sh
else
	echo
	echo "SKIP: upload-tests.sh / download-tests.sh (curl not installed - opkg install curl)"
fi

echo
if [ "$OVERALL" = "0" ]; then
	echo "== ALL STAGES PASSED =="
else
	echo "== SOME STAGES REPORTED FAILURES - see above =="
fi
exit "$OVERALL"
