#!/bin/sh
# Wrt Commander - deploy/install.sh
#
# The installer moved to the project root, so that the one-line install
# from GitHub can point at a single file:
#
#   wget -q -O - https://raw.githubusercontent.com/p0sixxx/luci-app-wrtcommander/main/install.sh | sh
#
# This is left here so that "sh deploy/install.sh" keeps working; it just
# hands over to the real one with the same arguments.

exec sh "$(cd "$(dirname "$0")/.." && pwd)/install.sh" "$@"
