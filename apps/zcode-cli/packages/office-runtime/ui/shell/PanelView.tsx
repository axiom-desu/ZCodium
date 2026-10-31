import { Icon } from "#ui/icons.tsx";
import { baseName } from "#ui/rpc.ts";
import { InlineShell } from "#ui/shell/inline.tsx";
import { MoreMenu, SwitchMenu } from "#ui/shell/menus.tsx";
import {
  ChangedBanner,
  Drawer,
  EmptyState,
  ErrorState,
  Skeleton,
} from "#ui/shell/panes.tsx";
import {
  AgentCallout,
  FindBar,
  OffscreenChip,
  PagePill,
  SelectionBar,
  offscreenText,
} from "#ui/shell/parts.tsx";
import { clip } from "#ui/shell/state.ts";
import type { PanelController } from "#ui/shell/usePanelController.ts";

/** All three panel layouts (inline glance, side panel, full screen) over one controller. */
export function PanelView({ panel }: { panel: PanelController }) {
  const {
    appRef, canvasRef, t, host, path, doc, kind, showSkeleton, failure, nothing, viewer,
    viewerProps, Viewer, find, queryFind, stepFind, closeFind, openFind, ready, pending,
    drawer, drawerAvailable, setDrawer, menu, setMenu, changed, load, setChanged,
    dismissedRevision, filePicker, docked, goToPage, page, paged, picked, label, barMode,
    setBarMode, setAgent, copied, addReference, ask, copy, agent, stepAgent, zoom, notice, recent,
    openPath,
    offscreen, inline, ZOOMABLE,
  } = panel;
  if (inline)
    return (
      <InlineShell
        appRef={appRef}
        canvasRef={canvasRef}
        t={t}
        path={path}
        info={doc?.info}
        kind={kind}
        showSkeleton={showSkeleton}
        failure={failure}
        nothing={nothing}
        onExpand={() =>
          void host.app.requestDisplayMode({ mode: "fullscreen" }).catch(() => undefined)
        }
      >
        {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
      </InlineShell>
    );

  return (
    <div ref={appRef} className="app">
      {nothing ? null : find.open ? (
        <FindBar
          t={t}
          query={find.query}
          total={find.total}
          index={find.index}
          onQuery={queryFind}
          onStep={stepFind}
          onClose={closeFind}
        />
      ) : (
        <header className="docbar">
          {doc || pending || failure ? (
            <button
              type="button"
              className={`btn icon ${drawer.open && drawerAvailable ? "secondary" : "dim"}`}
              title={t.pagesAndOutline}
              aria-label={t.pagesAndOutline}
              aria-pressed={drawer.open && drawerAvailable}
              disabled={!drawerAvailable}
              hidden={kind === "xlsx"}
              onClick={() => setDrawer((state) => ({ ...state, open: !state.open }))}
            >
              <Icon name="panel-left" />
            </button>
          ) : null}
          <button
            type="button"
            className={`doctitle${menu === "switch" ? " open" : ""}`}
            title={path ?? undefined}
            aria-haspopup="menu"
            aria-expanded={menu === "switch"}
            aria-label={`${t.switchDocument}: ${path ?? ""}`}
            data-menu-trigger=""
            onClick={() => setMenu((value) => (value === "switch" ? null : "switch"))}
          >
            <span className="name">{path ? baseName(path) : t.title}</span>
            <Icon name="chevron-down" size={12} className="chev" />
          </button>
          <span className="spacer" />
          {doc && !failure ? (
            <>
              <button
                type="button"
                className="btn icon dim"
                title={`${t.find} (⌘F)`}
                aria-label={t.find}
                disabled={!ready}
                onClick={openFind}
              >
                <Icon name="search" />
              </button>
              <button
                type="button"
                className={`btn icon dim${menu === "more" ? " active" : ""}`}
                title={t.more}
                aria-label={t.more}
                aria-haspopup="menu"
                aria-expanded={menu === "more"}
                data-menu-trigger=""
                onClick={() => setMenu((value) => (value === "more" ? null : "more"))}
              >
                <Icon name="ellipsis" />
              </button>
            </>
          ) : null}
        </header>
      )}
      {changed ? (
        <ChangedBanner
          t={t}
          onReload={() => doc && void load(doc.info.path)}
          onDismiss={() => {
            dismissedRevision.current = changed;
            setChanged(null);
          }}
        />
      ) : null}
      {nothing ? (
        <EmptyState t={t} importing={filePicker.importing} onBrowse={filePicker.browse} />
      ) : (
        <div className="stage">
          {drawer.open && drawerAvailable && doc ? (
            <>
              {docked ? null : (
                <div
                  className="scrim"
                  onClick={() => setDrawer((state) => ({ ...state, open: false }))}
                />
              )}
              <Drawer
                t={t}
                info={doc.info}
                handle={viewer.current}
                page={paged ? page : null}
                tab={drawer.tab}
                docked={docked}
                onTab={(tab) => setDrawer((state) => ({ ...state, tab }))}
                onPage={(n) => {
                  goToPage(n);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
                onOutline={(at) => {
                  viewer.current?.goTo(at);
                  if (!docked) setDrawer((state) => ({ ...state, open: false }));
                }}
              />
            </>
          ) : null}
          <div ref={canvasRef} className="canvas">
            {Viewer && viewerProps ? <Viewer key={doc!.key} ref={viewer} {...viewerProps} /> : null}
            {showSkeleton ? <Skeleton kind={kind} /> : null}
            {failure ? (
              <ErrorState
                t={t}
                title={failure.title}
                detail={failure.detail}
                onOpenAnother={filePicker.browse}
              />
            ) : null}
            {doc && ready && !failure && picked?.detail.user ? (
              <SelectionBar
                key={`${picked.selection.at}:${picked.selection.text.length}`}
                t={t}
                frame={canvasRef}
                locate={picked.detail.locate}
                text={picked.detail.text}
                label={label}
                quote={clip(picked.selection.text.replace(/\s+/g, " "), 60)}
                short={doc.info.kind === "xlsx"}
                mode={barMode}
                canAsk={Boolean(host.capabilities?.message)}
                copied={copied}
                onAdd={() => void addReference()}
                onAsk={() => setBarMode("ask")}
                onCopy={() => void copy()}
                onCancelAsk={() => setBarMode("bar")}
                onSend={ask}
              />
            ) : null}
            {agent?.visible && agent.targets[agent.index] && !failure ? (
              <AgentCallout
                t={t}
                frame={canvasRef}
                locate={agent.targets[agent.index].locate}
                note={agent.note}
                index={agent.index}
                total={agent.targets.length}
                onNext={() => stepAgent()}
                onClose={() => setAgent({ ...agent, visible: false })}
              />
            ) : null}
            {agent && offscreen ? (
              <OffscreenChip
                text={offscreenText(
                  t,
                  offscreen.indexes.map((i) => agent.targets[i].at),
                )}
                down={offscreen.down}
                raised={paged}
                onClick={() => stepAgent(offscreen.indexes[0])}
              />
            ) : null}
            {doc && ready && !failure && paged && page ? (
              <PagePill
                t={t}
                frame={canvasRef}
                page={page}
                zoom={kind && ZOOMABLE.includes(kind) ? zoom : null}
                onPage={goToPage}
                onZoom={(direction) => viewer.current?.zoom(direction)}
                onFit={() => viewer.current?.fit("width")}
              />
            ) : null}
            {notice ? <div className="chip notice">{notice}</div> : null}
          </div>
        </div>
      )}
      {menu === "switch" ? (
        <SwitchMenu
          t={t}
          recent={recent}
          currentPath={doc?.info.path}
          onOpen={openPath}
          onBrowse={() => {
            setMenu(null);
            filePicker.browse();
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "more" && doc ? (
        <MoreMenu
          t={t}
          zoomable={ZOOMABLE.includes(doc.info.kind)}
          zoomMode={zoom?.mode}
          onFit={(mode) => {
            viewer.current?.fit(mode);
            setMenu(null);
          }}
          onFind={openFind}
          onReload={() => {
            setMenu(null);
            void load(doc.info.path);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {filePicker.input}
    </div>
  );
}
