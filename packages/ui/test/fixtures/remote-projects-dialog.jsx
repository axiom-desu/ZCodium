import { createRoot } from "react-dom/client";
import { RemoteProjectsDialog } from "../../src/project-sidebar/RemoteProjectsDialog.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";

const fixture = (window.remoteProjectFixture = {
  entries: [
    {
      entryId: "entry-live",
      hostId: "source-a",
      remoteProjectId: "remote-1",
      name: "Live remote",
      roots: ["/remote/live"],
      cachedDeleted: false,
      lastSyncedAt: null,
    },
    {
      entryId: "entry-deleted",
      hostId: "source-a",
      remoteProjectId: "remote-2",
      name: "Deleted remote",
      roots: ["/remote/deleted"],
      cachedDeleted: true,
      lastSyncedAt: null,
    },
  ],
  removed: [],
  restored: [],
  closed: false,
});

const service = {
  async listEntries() {
    return fixture.entries;
  },
  async readCatalog() {
    return {
      localProjects: [],
      remoteProjects: fixture.entries.filter((entry) => !entry.cachedDeleted),
    };
  },
  async removeEntry({ entryId }) {
    fixture.removed.push(entryId);
    fixture.entries = fixture.entries.filter((entry) => entry.entryId !== entryId);
  },
  async restoreEntry({ entryId }) {
    fixture.restored.push(entryId);
    fixture.entries = fixture.entries.map((entry) =>
      entry.entryId === entryId ? { ...entry, cachedDeleted: false } : entry,
    );
    return fixture.entries.find((entry) => entry.entryId === entryId);
  },
};

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <ServiceProvider services={{ remoteProjectService: service }}>
      <RemoteProjectsDialog
        open
        onClose={() => {
          fixture.closed = true;
        }}
      />
    </ServiceProvider>
  </ZCodeIntlProvider>,
);
