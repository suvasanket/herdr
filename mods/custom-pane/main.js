// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "custom-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, nextCommand, focused, spaces, hc } from "herdr";

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.openingNeovim = false;
    cx.spawn(async () => {
      for (;;) {
        const command = await nextCommand();
        if (command === "smart-close") {
          this.handleSmartClose();
        } else if (command === "open-neovim" || command === "open-vim") {
          this.handleOpenNeovim();
        }
      }
    });
  }

  handleSmartClose() {
    const p = this.me();
    if (!p) return;
    const f = focused();
    const activeSpace = spaces().find((s) => s.active);
    const activeTabId = f?.tab ?? activeSpace?.tabs.find((t) => t.active)?.id;
    if (p.tab !== activeTabId) return;

    const tabPanes = panes().filter((x) => x.tab === p.tab);
    if (tabPanes.length > 1) {
      const targetPane = tabPanes.find((x) => x.focused) ?? tabPanes.find((x) => x.pane === f?.pane) ?? tabPanes[0];
      if (targetPane && targetPane.pane === p.pane) {
        run("pane.close", { pane: p.pane });
      }
    } else if (tabPanes.length === 1) {
      run("tab.close", { id: p.tab });
    }
  }

  async handleOpenNeovim() {
    if (this.openingNeovim) return;
    this.openingNeovim = true;
    try {
      const p = this.me();
      if (!p) return;
      const f = focused();
      const activeSpace = spaces().find((s) => s.active);
      const activeTabId = f?.tab ?? activeSpace?.tabs?.find((t) => t.active)?.id;
      if (p.tab !== activeTabId) return;

      const tabPanes = panes().filter((x) => x.tab === p.tab);
      const targetPane =
        (f?.pane ? tabPanes.find((x) => x.pane === f.pane) : null) ??
        (f?.terminal ? tabPanes.find((x) => x.terminal === f.terminal) : null) ??
        tabPanes.find((x) => x.focused) ??
        tabPanes[0];

      if (!targetPane || targetPane.pane !== p.pane) return;

      const terminal = targetPane.terminal;
      if (!terminal) {
        run("tab.new", { argv: ["nvim"], folder: targetPane.cwd || undefined, space: activeSpace?.id });
        return;
      }

      let isBusy = false;
      try {
        const res = await hc(["get", terminal, "--json"]);
        if (res.code === 0) {
          const info = JSON.parse(res.stdout);
          const SHELLS = new Set(["zsh", "bash", "fish", "sh", "csh", "tcsh", "ksh", "nu", "pwsh", "cmd.exe", "powershell.exe"]);
          const fg = info.foreground;
          const fgName = fg?.name?.toLowerCase() ?? "";
          const isFgShell = SHELLS.has(fgName);

          if (info.status || targetPane.status) {
            isBusy = true;
          } else if (fg && info.pid && fg.pid !== info.pid) {
            isBusy = true;
          } else if (fg && !isFgShell) {
            isBusy = true;
          } else if (targetPane.program && !targetPane.program.shell) {
            isBusy = true;
          }
        } else {
          if (targetPane.status || (targetPane.program && !targetPane.program.shell)) {
            isBusy = true;
          }
        }
      } catch {
        if (targetPane.status || (targetPane.program && !targetPane.program.shell)) {
          isBusy = true;
        }
      }

      if (isBusy) {
        run("tab.new", { argv: ["nvim"], folder: targetPane.cwd || undefined, space: activeSpace?.id });
      } else {
        await hc(["send", "--force", terminal, "nvim"]);
        run("pane.focus", { pane: targetPane.pane });
      }
    } finally {
      this.openingNeovim = false;
    }
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/custom-pane/${icon}.svg`).size(14));
  }

  syncTabs() {
    const root = layout();
    const sidebar = find(root, "sidebar");
    const tabs = find(root, "tabs");
    if (sidebar && tabs) {
      const sidebarHidden = Boolean(sidebar.hidden);
      const tabsHidden = Boolean(tabs.hidden);
      const wantTabsHidden = !sidebarHidden;
      if (tabsHidden !== wantTabsHidden) {
        if (!this.pendingTabs || this.pendingTabs.want !== wantTabsHidden || Date.now() > this.pendingTabs.until) {
          this.pendingTabs = { want: wantTabsHidden, until: Date.now() + 1000 };
          if (wantTabsHidden) run("layout.hide", { id: "tabs" });
          else run("layout.show", { id: "tabs" });
        }
      } else {
        this.pendingTabs = null;
      }
    }
  }

  render(cx) {
    this.syncTabs();
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .rounded_t(12)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
