import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ProjectWorktreeDialog } from "../../src/project-sidebar/ProjectWorktreeDialog.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";

const fixture = (window.worktreeFixture = {
  created: 0,
  removed: [],
  selected: [],
  changed: 0,
  closed: false,
  groups: [
    {
      sourceRoot: "/fixture/repo",
      worktrees: [
        {
          path: "/fixture/worktrees/ab12/repo",
          sourceRoot: "/fixture/repo",
          bucket: "ab12",
          head: "abcdef123456",
          branch: "main",
          dirty: false,
          creating: false,
          tasks: [
            {
              taskId: "task-1",
              workspacePath: "/fixture/worktrees/ab12/repo",
              projectId: "project-1",
              title: "Task one",
              archived: false,
            },
          ],
        },
      ],
    },
  ],
});

const service = {
  async listWorktrees() {
    return { groups: fixture.groups };
  },
  async listStartRefs() {
    return null;
  },
  async supportsWorktreeCwd() {
    return true;
  },
  async createTask() {
    fixture.created += 1;
    return {
      ok: true,
      value: {
        creationId: "creation-1",
        taskId: "task-2",
        workspacePath: "/fixture/worktrees/cd34/repo",
        worktreeRoot: "/fixture/worktrees/cd34/repo",
        projectId: "project-1",
      },
    };
  },
  async removeWorktree({ worktreeRoot }) {
    fixture.removed.push(worktreeRoot);
    fixture.groups = [];
    return { ok: true, value: undefined };
  },
  async isWorktreeAvailable() {
    return true;
  },
};

function App() {
  const [open] = useState(true);
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <ServiceProvider services={{ managedWorktreeService: service }}>
        <ProjectWorktreeDialog
          open={open}
          project={{
            id: "project-1",
            hostId: "local",
            name: "Repo",
            roots: [{ rootPath: "/fixture/repo", position: 0, isPrimary: true }],
            position: 0,
            pinned: false,
            deleted: false,
            nameOverridden: false,
            createdAt: 0,
            updatedAt: 0,
          }}
          onClose={() => {
            fixture.closed = true;
          }}
          onSelectTask={(workspacePath, taskId) => {
            fixture.selected.push([workspacePath, taskId]);
          }}
          onChanged={() => {
            fixture.changed += 1;
          }}
        />
      </ServiceProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")).render(<App />);
