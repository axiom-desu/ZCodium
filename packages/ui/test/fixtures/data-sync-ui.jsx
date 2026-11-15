import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { DataSyncDialog } from "@/data-sync/ui/DataSyncDialog.js";

// 真实 DataSyncDialog + 真实比较/推送/Provider hooks；服务替身只实现契约（内存文件库 + CAS），
// 不复制产品逻辑。临时 HOME 语义由夹具内 store 表示，不读用户数据、不连远端。

const LOCAL = { alpha: "A1", beta: "B1", gamma: "G1" };
const REMOTE_INITIAL = { beta: "B1", gamma: "G0", delta: "D1" };

const writes = [];
const pushResults = [];
const remote = { ...REMOTE_INITIAL };

function hash(value) {
  return value;
}

function createCategoryService(store, { record } = {}) {
  return {
    async listSyncItems() {
      return {
        items: Object.entries(store).map(([key, value]) => ({
          key,
          name: key,
          enabled: true,
          contentHash: hash(value),
        })),
        homeDir: "/home/fixture",
      };
    },
    async getSyncContentHashes({ keys }) {
      return {
        hashes: Object.fromEntries(
          keys.filter((key) => key in store).map((key) => [key, hash(store[key])]),
        ),
      };
    },
    async checkSyncWriteAccess() {
      return { ok: true, path: "/home/fixture/.config" };
    },
    async exportSyncItems({ keys }) {
      return { entries: Object.fromEntries(keys.map((key) => [key, store[key]])) };
    },
    async importSyncItems({ payload, items }) {
      return {
        results: items.map((item) => {
          const existing = store[item.key];
          const next = payload.entries[item.key];
          if (item.mode === "createOnly" && existing !== undefined) {
            return { key: item.key, status: "conflict" };
          }
          if (item.mode === "overwrite" && item.expectedTargetHash !== hash(existing)) {
            return { key: item.key, status: "conflict" };
          }
          store[item.key] = next;
          record?.({ key: item.key, mode: item.mode, value: next });
          return { key: item.key, status: existing === undefined ? "created" : "updated" };
        }),
      };
    },
  };
}

const emptyCategory = {
  listSyncItems: async () => ({ items: [], homeDir: "/home/fixture" }),
  getSyncContentHashes: async () => ({ hashes: {} }),
  checkSyncWriteAccess: async () => ({ ok: true, path: "/home/fixture/.config" }),
  exportSyncItems: async () => ({}),
  importSyncItems: async ({ items }) => ({
    results: items.map((item) => ({ key: item.key, status: "skipped" })),
  }),
};

function createServices({ local }) {
  const category = local
    ? createCategoryService(LOCAL)
    : createCategoryService(remote, { record: (entry) => writes.push(entry) });
  return {
    systemService: { info: async () => ({ homedir: "/home/fixture" }) },
    mcpSyncService: category,
    // 旧 Server 缺方法：分类必须显示 typed unsupported，不能显示为空列表成功。
    skillSyncService: local
      ? {
          ...emptyCategory,
          listSyncItems: async () => {
            throw new Error("Method not found: listSyncItems");
          },
        }
      : emptyCategory,
    pluginSyncService: emptyCategory,
    userConfigSyncService: {
      listSyncItems: async () => ({ items: [], homeDir: "/home/fixture" }),
      getSyncContentHashes: async () => ({ hashes: {} }),
      checkSyncWriteAccess: async () => ({ ok: true, path: "" }),
      exportSyncItems: async () => ({}),
      importSyncItems: async ({ items }) => ({
        results: items.map((item) => ({ key: item.key, status: "skipped" })),
      }),
    },
  };
}

const providerView = {
  revision: 1,
  providerTemplates: [],
  providerOrder: ["openai"],
  providers: [
    {
      providerId: "openai",
      providerName: "OpenAI",
      enabled: true,
      executable: true,
      issues: [],
      personalConfig: { api: { baseUrl: "https://api.example.test/v1" } },
      effectiveConfig: {
        api: { baseUrl: "https://api.example.test/v1" },
        access: { apiKey: "sk-test-1234567890abcd" },
      },
      models: [
        {
          modelId: "gpt-x",
          enabled: true,
          kind: "candidate",
          builtin: false,
          executable: true,
          selectable: true,
          issues: [],
          effectiveConfig: {},
        },
      ],
    },
  ],
};

function createAccessor({ local }) {
  const base = createServices({ local });
  const lane = local
    ? {
        getStatus: async () => ({
          lane: "present",
          running: false,
          lastResult: { at: Date.now(), outcome: "failed", errorCode: "target-call-failed" },
        }),
        retry: async () => ({
          lane: "present",
          running: false,
          lastResult: { at: Date.now(), outcome: "success" },
        }),
      }
    : undefined;
  return {
    ...base,
    providerSettingsService: { getView: async () => providerView },
    providerProvisioningStatusService: lane,
  };
}

const sourceServices = createAccessor({ local: true });
const targetServices = createAccessor({ local: false });

function Fixture() {
  const [online, setOnline] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [open, setOpen] = useState(true);
  const device = useMemo(
    () => ({
      sourceServerId: "00000000-0000-4000-8000-000000000001",
      name: "fixture-device",
      description: "SSH · fixture@127.0.0.1:22",
    }),
    [],
  );

  useEffect(() => {
    window.dataSyncFixture = {
      getWrites: () => writes,
      getPushResults: () => pushResults,
      getRemote: () => remote,
      mutateRemote(key, value) {
        remote[key] = value;
      },
      setOnline,
      reset() {
        for (const key of Object.keys(remote)) delete remote[key];
        Object.assign(remote, REMOTE_INITIAL);
        writes.length = 0;
        pushResults.length = 0;
      },
    };
  }, []);

  return (
    <div style={{ minHeight: "100vh" }} data-testid="data-sync-fixture">
      <DataSyncDialog
        open={open}
        minimized={minimized}
        onMinimizedChange={setMinimized}
        device={device}
        online={online}
        sourceServices={sourceServices}
        targetServices={online ? targetServices : undefined}
        initialCategory="mcp"
        onOpenChange={setOpen}
        onPushFinished={(result) => {
          pushResults.push(result);
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider>
    <Fixture />
  </ZCodeIntlProvider>,
);
