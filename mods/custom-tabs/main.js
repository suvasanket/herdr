import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, readTextFile, writeTextFile, appHome } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    this.paddingSync = null;
  }

  syncTerminalPadding(noSidebar) {
    const value = noSidebar ? [0, 0] : [8, 8];
    const key = value.join(",");
    this.requestedPadding = key;
    if (this.paddingSync || this.lastPadding === key) return;
    this.paddingSync = true;
    const path = `${appHome()}/layouts/custom.json`;
    readTextFile(path).then((text) => {
      if (!text) return;
      const tree = JSON.parse(text);
      const findNode = (node, id) => {
        if (node?.id === id) return node;
        for (const child of node?.children ?? []) {
          const found = findNode(child, id);
          if (found) return found;
        }
        return null;
      };
      const body = findNode(tree, "work-body");
      if (!body || JSON.stringify(body.padding) === JSON.stringify(value)) {
        this.lastPadding = key;
        return null;
      }
      body.padding = value;
      return writeTextFile(path, JSON.stringify(tree, null, 2) + String.fromCharCode(10), text).then(() => {
        this.lastPadding = key;
      });
    }).catch((error) => console.log("Could not sync custom terminal padding", error))
      .finally(() => {
        this.paddingSync = false;
        if (this.requestedPadding !== this.lastPadding) this.syncTerminalPadding(this.requestedPadding === "0,0");
      });
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const allPanes = panes().filter(p => p.tab === c.id);
      const lead = allPanes.find(p => p.program?.agent) ?? allPanes.find(p => p.focused) ?? allPanes[0];
      const program = lead?.program;
      const liveTitle = (lead?.title ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
      const name = (c.named && !/^\d+$/.test(c.name)) ? c.name : (liveTitle || program?.name || c.name || "Terminal");
      const st = c.status || lead?.status || allPanes.find(p => p.status)?.status;
      const iconPath = program?.icon ?? "icons/terminal.svg";
      const iconTint = program ? Boolean(program.tint) : true;
      const iconEl = iconTint
        ? svg(iconPath).size(14).flex_none().text_color(c.active ? t.foreground : t.muted)
        : image(iconPath).size(14).flex_none();
      const showText = true;
      return h_flex().id(`tab-${c.id}`).h(tabCellHeight).px(showText ? 8 : 6).gap(6).rounded(5).items_center().flex_none().text_size(12)
        .border(1).border_color(c.active ? t.border : "#00000000").bg(c.active ? t.background : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .tooltip(c.zoomed ? `${name} (zoomed)` : name)
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .child(iconEl)
        .when(showText, el => el.child(div().max_w(220).truncate().child(c.zoomed ? `${name} Z` : name)))
        .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(st === "blocked" || st === "done", el => el.child(div().size(6).rounded(3).bg(t[st])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover(s => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(11))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const noSidebar = !sidebar || Boolean(sidebar.hidden);
    this.syncTerminalPadding(noSidebar);
    const framePadding = 8;
    const trafficLightLeft = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? (root.traffic_lights[0] + 56) / settings().zoom + 12
      : framePadding;
    const tabCellHeight = 24;
    const tabHeight = 28;
    const lightsPadding = noSidebar ? trafficLightLeft : Math.max(framePadding, trafficLightLeft - (sidebar?.size?.px ?? 0));
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(22).px(7).gap(5).flex_none().items_center().rounded(5)
        .text_size(11.5).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    const hasLonePane = shown.find(x => x.active)?.panes === 1;
    const border = hasLonePane ? 0 : 1;
    return h_flex().size_full().min_w(0).h(tabHeight).px(framePadding).pl(lightsPadding).gap(4).items_center().bg(t.chrome).border_b(border).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h(tabCellHeight).items_center().gap(3).overflow_x_scrollbar().children(shown.map(item))
        .child(div().id("tab-new").size(20).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().on_mouse_down("left", stop).on_click(() => run("tab.new")).child("+")))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .child(button("sidebar-toggle", svg("mods/custom-workspace-chrome/sidebar.svg").size(14), () => run("layout.toggle", { id: "sidebar" })))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/custom-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/custom-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/custom-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
