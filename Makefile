# luci-app-wrtcommander — two-pane commander-style file manager for LuCI
#
# The JS view and every regular filesystem operation (list, stat, mkdir,
# rename, copy, move, delete, chmod, chown, search, disk_info, dirsize,
# small file read/write) go through the "luci.wrtcommander" ubus object,
# implemented by the rpcd ucode plugin root/usr/share/rpcd/ucode/wrtcommander.uc.
#
# Arbitrarily large upload/download cannot reasonably go through ubus
# (no streaming, base64 overhead, message size limits), so those two
# operations use plain HTTP via the Lua controller under
# root/usr/lib/lua/luci/controller/ — the one part that needs
# luci-lua-runtime.

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-wrtcommander
PKG_VERSION:=1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0
PKG_MAINTAINER:=p0sixxx

LUCI_TITLE:=Wrt Commander
LUCI_DESCRIPTION:=Two-pane commander-style file manager for LuCI: browse, preview, edit, upload/download, copy/move, chmod/chown and search.
LUCI_DEPENDS:=+luci-base +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-math +luci-lua-runtime +luci-lib-nixio +libubus-lua
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/p0sixxx/luci-app-wrtcommander

# /etc/config/wrtcommander holds user settings; keep it across upgrades.
define Package/luci-app-wrtcommander/conffiles
/etc/config/wrtcommander
endef

# The ubus backend is only picked up after an rpcd reload; drop the LuCI
# caches too so the menu entry shows up without a logout.
define Package/luci-app-wrtcommander/postinst
[ -n "$${IPKG_INSTROOT}" ] || { \
	rm -f /tmp/luci-indexcache*; \
	rm -rf /tmp/luci-modulecache; \
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null; \
	exit 0; \
}
endef

define Package/luci-app-wrtcommander/prerm
[ -n "$${IPKG_INSTROOT}" ] || { \
	rm -f /tmp/luci-indexcache*; \
	rm -rf /tmp/luci-modulecache; \
	/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null; \
	exit 0; \
}
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
