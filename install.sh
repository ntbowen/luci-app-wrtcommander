#!/bin/sh
# Wrt Commander - install.sh
#
# The one installer, for installing and for updating. Run ON the router,
# as root, either straight from GitHub:
#
#   wget -q -O - https://raw.githubusercontent.com/p0sixxx/luci-app-wrtcommander/main/install.sh | sh
#
# or from an unpacked copy of the project:
#
#   sh install.sh
#
# Options (after "sh -s --" when piped, e.g.
#   wget -q -O - .../install.sh | sh -s -- --no-deps):
#
#   --no-deps        do not touch the package manager, only check that the
#                    dependencies are present (for routers without internet)
#   --force-config   also overwrite an existing /etc/config/wrtcommander
#                    (by default an existing config is left untouched)
#
# Read from a pipe, the script has no project files next to it: it then
# downloads the branch as an archive and runs the install.sh inside it.
# From an unpacked copy it installs right away:
#
#   1. checks the dependencies and installs whatever is missing through apk
#      (25.12 and newer) or opkg (up to 24.10);
#   2. parses the ucode backend and stops before touching the live install
#      if it does not parse;
#   3. copies the files listed in deploy/MANIFEST and keeps a copy of
#      MANIFEST and uninstall.sh in /usr/share/luci-app-wrtcommander, so
#      removal works later without the project;
#   4. reloads rpcd, drops the LuCI caches and checks that the backend
#      came up on ubus.

set -e

REPO="${WRTCOMMANDER_REPO:-p0sixxx/luci-app-wrtcommander}"
BRANCH="${WRTCOMMANDER_BRANCH:-main}"
SHARE=/usr/share/luci-app-wrtcommander

INSTALL_DEPS=1
FORCE_CONFIG=0
for arg in "$@"; do
	case "$arg" in
		--no-deps) INSTALL_DEPS=0 ;;
		--force-config) FORCE_CONFIG=1 ;;
		*) echo "Unknown option: $arg" >&2; exit 1 ;;
	esac
done

echo "== Wrt Commander installer =="

if [ "$(id -u)" != "0" ]; then
	echo "ERROR: this must be run as root on the router." >&2
	exit 1
fi

if [ ! -f /etc/openwrt_release ]; then
	echo "ERROR: /etc/openwrt_release not found - this does not look like an OpenWrt system." >&2
	exit 1
fi

# ------------------------------------------------------------------
# where the project files are
# ------------------------------------------------------------------

# Empty when the script is read from a pipe ($0 is then the shell itself).
SELF_DIR=""
case "$0" in
	install.sh|*/install.sh)
		[ -f "$0" ] && SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
		;;
esac

if [ -z "$SELF_DIR" ] || [ ! -f "$SELF_DIR/runtime/usr/share/rpcd/ucode/wrtcommander.uc" ]; then
	# Guard against a loop if the downloaded copy turns out incomplete.
	if [ -n "$WRTCOMMANDER_FETCHED" ]; then
		echo "ERROR: the downloaded project is incomplete - no runtime/ next to install.sh." >&2
		exit 1
	fi

	URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
	WORK=/tmp/luci-app-wrtcommander-install
	echo "Downloading $URL"

	rm -rf "$WORK"
	mkdir -p "$WORK"

	# wget on a stock image is uclient-fetch; HTTPS needs ca-bundle and a
	# TLS backend, which is the usual reason this step fails. curl is tried
	# as well because an image may carry one and not the other.
	fetched=0
	if command -v wget >/dev/null 2>&1 && wget -q -O "$WORK/src.tar.gz" "$URL"; then
		fetched=1
	elif command -v curl >/dev/null 2>&1 && curl -fsSL -o "$WORK/src.tar.gz" "$URL"; then
		fetched=1
	fi
	if [ "$fetched" != "1" ]; then
		echo "ERROR: download failed - is the router online?" >&2
		echo "       If the network is fine, HTTPS may be the problem: install" >&2
		echo "       'ca-bundle' and a TLS backend ('libustream-mbedtls')." >&2
		exit 1
	fi

	tar -xzf "$WORK/src.tar.gz" -C "$WORK"

	# The archive's top directory is named after the repository and the
	# branch, and a branch name with a slash in it is flattened - so find
	# it rather than spelling it out.
	INNER=""
	for cand in "$WORK"/*/install.sh; do
		[ -f "$cand" ] || continue
		INNER="$cand"
		break
	done
	if [ -z "$INNER" ]; then
		echo "ERROR: the downloaded archive has no install.sh in it." >&2
		exit 1
	fi

	# stdin is the pipe this script is being read from: keep the real
	# installer off it, or anything reading stdin would eat the script.
	export WRTCOMMANDER_FETCHED=1
	exec sh "$INNER" "$@" </dev/null
fi

RUNTIME_DIR="$SELF_DIR/runtime"
MANIFEST="$SELF_DIR/deploy/MANIFEST"
UNINSTALL="$SELF_DIR/deploy/uninstall.sh"

# shellcheck disable=SC1091
. /etc/openwrt_release
echo "Target system: ${DISTRIB_ID:-OpenWrt} ${DISTRIB_RELEASE:-unknown}"

if [ ! -f "$MANIFEST" ]; then
	echo "ERROR: manifest not found at $MANIFEST" >&2
	exit 1
fi

# ------------------------------------------------------------------
# dependencies - before anything else, since the checks below need them
# ------------------------------------------------------------------

# Without these the app does not come up at all: the backend is a ucode
# plugin loaded by rpcd.
DEPS_REQUIRED="ucode rpcd-mod-ucode"
# Only upload and download go through the Lua controller; browsing, editing,
# deleting, copying, moving, permissions and search are all ubus. So these
# are worth installing but not worth refusing to install over.
DEPS_OPTIONAL="luci-lua-runtime luci-lib-nixio"

# 25.12 and newer use apk, earlier releases opkg.
if command -v apk >/dev/null 2>&1; then
	PM=apk
elif command -v opkg >/dev/null 2>&1; then
	PM=opkg
else
	PM=""
fi

# Queries only the database of installed packages, so it needs no network.
pkg_installed() {
	case "$PM" in
		apk)  apk info -e "$1" >/dev/null 2>&1 ;;
		# opkg: "Status: <want> <flags> <state>"; the state must be exactly
		# "installed", not "not-installed" or "half-installed".
		opkg) opkg status "$1" 2>/dev/null | grep -q '^Status: .* installed$' ;;
		*)    return 1 ;;
	esac
}

missing_from() {
	out=""
	for pkg in $1; do
		pkg_installed "$pkg" || out="$out $pkg"
	done
	echo "$out"
}

# The package index lives in /tmp and is gone after every reboot, so it is
# refreshed only when something actually has to be installed.
INDEX_FRESH=0
pm_update() {
	[ "$INDEX_FRESH" = "1" ] && return 0
	case "$PM" in
		apk)  apk update >/dev/null || return 1 ;;
		opkg) opkg update >/dev/null || return 1 ;;
		*)    return 1 ;;
	esac
	INDEX_FRESH=1
	return 0
}

pm_add() {
	case "$PM" in
		# shellcheck disable=SC2086
		apk)  apk add $1 ;;
		# shellcheck disable=SC2086
		opkg) opkg install $1 ;;
		*)    return 1 ;;
	esac
}

echo "Checking dependencies..."
if [ -z "$PM" ]; then
	echo "WARNING: neither apk nor opkg found, cannot check packages." >&2
else
	TODO=$(missing_from "$DEPS_REQUIRED")
	if [ -z "$TODO" ]; then
		echo "  all present: $DEPS_REQUIRED"
	elif [ "$INSTALL_DEPS" = "0" ]; then
		echo "ERROR: missing packages:$TODO" >&2
		echo "       install them, or run without --no-deps to let this script do it." >&2
		exit 1
	else
		echo "  installing:$TODO"
		pm_update || { echo "ERROR: refreshing the package index failed - is the router online?" >&2; exit 1; }
		pm_add "$TODO"
		TODO=$(missing_from "$DEPS_REQUIRED")
		if [ -n "$TODO" ]; then
			echo "ERROR: still missing after installation:$TODO" >&2
			exit 1
		fi
		echo "  OK"
	fi

	OPT=$(missing_from "$DEPS_OPTIONAL")
	if [ -n "$OPT" ] && [ "$INSTALL_DEPS" = "1" ]; then
		echo "  installing (for upload/download):$OPT"
		# Deliberately not fatal: a failure here costs file transfer, not
		# the app, so say what was lost and carry on.
		if pm_update && pm_add "$OPT"; then
			OPT=$(missing_from "$DEPS_OPTIONAL")
		fi
	fi
	if [ -n "$OPT" ]; then
		echo "WARNING: could not install:$OPT" >&2
		echo "         Upload and download need them; everything else works without." >&2
	fi
fi

# ------------------------------------------------------------------
# environment
# ------------------------------------------------------------------

MISSING=0
command -v ubus >/dev/null 2>&1 || { echo "ERROR: ubus not found." >&2; MISSING=1; }
command -v rpcd >/dev/null 2>&1 || { echo "ERROR: rpcd not found." >&2; MISSING=1; }
command -v ucode >/dev/null 2>&1 || { echo "ERROR: ucode interpreter not found." >&2; MISSING=1; }
[ -d /www/luci-static/resources ] || { echo "ERROR: LuCI does not appear to be installed (no /www/luci-static/resources)." >&2; MISSING=1; }
[ "$MISSING" = "1" ] && exit 1

if [ ! -d /usr/share/rpcd/ucode ]; then
	echo "WARNING: /usr/share/rpcd/ucode is missing - install 'rpcd-mod-ucode' or the backend will not load." >&2
fi

echo "Validating ucode backend syntax..."
if ! ucode "${RUNTIME_DIR}/usr/share/rpcd/ucode/wrtcommander.uc" >/tmp/wrtcommander-ucode-check.log 2>&1; then
	echo "ERROR: wrtcommander.uc failed to parse - aborting before touching the live install:" >&2
	cat /tmp/wrtcommander-ucode-check.log >&2
	rm -f /tmp/wrtcommander-ucode-check.log
	exit 1
fi
rm -f /tmp/wrtcommander-ucode-check.log
echo "  OK"

# ------------------------------------------------------------------
# files
# ------------------------------------------------------------------

echo "Installing files..."
while IFS= read -r line; do
	case "$line" in
		''|'#'*) continue ;;
	esac
	src=$(echo "$line" | awk '{print $1}')
	dst=$(echo "$line" | awk '{print $2}')
	[ -n "$src" ] && [ -n "$dst" ] || continue

	if [ "$dst" = "/etc/config/wrtcommander" ] && [ -f "$dst" ] && [ "$FORCE_CONFIG" != "1" ]; then
		echo "  skip    $dst (already exists - keeping your configuration, use --force-config to overwrite)"
		continue
	fi

	mkdir -p "$(dirname "$dst")"
	cp "${RUNTIME_DIR}/${src}" "$dst"
	chmod 0644 "$dst"
	echo "  install $dst"
done < "$MANIFEST"

# A record of what was installed, and the uninstaller next to it, so that
# removal works offline and removes exactly these files - which matters
# most for the one-line install, where there is no project left on disk.
mkdir -p "$SHARE"
cp "$MANIFEST" "$SHARE/MANIFEST"
chmod 0644 "$SHARE/MANIFEST"
if [ -f "$UNINSTALL" ]; then
	cp "$UNINSTALL" "$SHARE/uninstall.sh"
	chmod 0755 "$SHARE/uninstall.sh"
	echo "  install $SHARE/MANIFEST, $SHARE/uninstall.sh"
else
	echo "  install $SHARE/MANIFEST"
fi

# ------------------------------------------------------------------
# reload
# ------------------------------------------------------------------

echo "Reloading rpcd and clearing the LuCI caches..."
rm -f /tmp/luci-indexcache* 2>/dev/null || true
rm -rf /tmp/luci-modulecache 2>/dev/null || true
if [ -x /etc/init.d/rpcd ]; then
	/etc/init.d/rpcd reload >/dev/null 2>&1 || /etc/init.d/rpcd restart >/dev/null 2>&1 || true
else
	echo "WARNING: /etc/init.d/rpcd not found, could not reload rpcd." >&2
fi

sleep 1
echo "Verifying the backend is registered on ubus..."
if ubus list 2>/dev/null | grep -qx 'luci.wrtcommander'; then
	echo "  luci.wrtcommander is registered."
else
	echo "WARNING: luci.wrtcommander was not found on ubus after reload." >&2
	echo "         Try: /etc/init.d/rpcd restart ; ubus list | grep wrtcommander" >&2
	echo "         Check: logread | grep rpcd" >&2
fi

if [ -f /usr/lib/lua/luci/i18n/wrtcommander.ru.lmo ]; then
	echo "Russian translation installed."
	echo "  LuCI shows it when its language is Russian or set to auto with a"
	echo "  Russian browser: System -> System -> Language, or"
	echo "  uci set luci.main.lang=ru; uci commit luci"
	if [ ! -f /usr/lib/lua/luci/i18n/base.ru.lmo ]; then
		echo "WARNING: LuCI's own Russian catalog (base.ru.lmo) is not installed," >&2
		echo "         so most of the surrounding interface stays English." >&2
		echo "         Install 'luci-i18n-base-ru' for a fully Russian LuCI." >&2
	fi
fi

echo
echo "Wrt Commander installed successfully."
echo "Open LuCI -> Services -> Wrt Commander in your browser."
echo "(If the menu entry is missing, log out and back in, or hard-refresh the page.)"
echo "To remove it later: sh $SHARE/uninstall.sh"
