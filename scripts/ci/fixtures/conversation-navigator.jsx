import * as React from "react";
import { createRoot } from "react-dom/client";
import { ConversationTurnNavigator } from "../../../packages/ui/src/v4/ConversationTurnNavigator.js";
import { buildConversationTurnRenderUnits } from "../../../packages/ui/src/v4/conversationTurnRenderUnits.js";
import { useZCodeIntl, ZCodeIntlProvider } from "../../../packages/ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../../packages/ui/src/components/ui/tooltip.js";

const ROWS_PER_TURN = 3;
const makeTurn = (
  turn,
  firstRowId,
  session = "alpha",
  { assistant = true, running = false } = {},
) => {
  const turnId = `${session}-turn-${turn}`;
  const base = { turnId, productTurnId: `${turnId}-product`, createdAt: turn, createdAtSeq: turn };
  return [
    {
      ...base,
      rowId: firstRowId,
      kind: "turnHeader",
      origin: "userInput",
      state: running ? "running" : "completedSuccess",
      startedAt: turn,
    },
    {
      ...base,
      rowId: firstRowId + 1,
      kind: "userInput",
      origin: "realUser",
      text: `${session} question ${turn}`,
    },
    ...(assistant
      ? [
          {
            ...base,
            rowId: firstRowId + 2,
            kind: "assistantText",
            state: "complete",
            text: `${session} answer ${turn}`,
          },
        ]
      : []),
  ];
};

const suspended = new Promise(() => {});
function SuspendAfterNavigator({ active }) {
  if (active) {
    // Fixture marker proves Navigator finished the discarded render before suspension.
    window.navigatorSuspendedAttempts = (window.navigatorSuspendedAttempts ?? 0) + 1;
    throw suspended;
  }
  return null;
}

function Fixture() {
  const { setLocale } = useZCodeIntl();
  const [rows, setRows] = React.useState(() =>
    Array.from({ length: 100 }, (_, index) =>
      makeTurn(index + 1, 3000 + index * ROWS_PER_TURN, "alpha", {
        assistant: index !== 2 && index !== 99,
        running: false,
      }),
    ).flat(),
  );
  const [revision, setRevision] = React.useState(0);
  const [sessionKey, setSessionKey] = React.useState("alpha");
  const [actions, setActions] = React.useState([]);
  const [suspend, setSuspend] = React.useState(false);
  const beforeAttempt = React.useRef(rows);
  // Deliberately rebuild on clock ticks while retaining source row references.
  const units = buildConversationTurnRenderUnits(rows);
  const virtualItems = units.map((unit, index) => ({
    index,
    start: index * 100,
    size: 100,
    key: unit.key,
  }));
  const jump = (target) => setActions((current) => [...current, target]);
  return (
    <>
      <div className="controls">
        <button
          data-testid="pending"
          onClick={() => {
            beforeAttempt.current = rows;
            React.startTransition(() => {
              setRows((current) =>
                current.map((row) =>
                  row.rowId === 3002 ? { ...row, text: "ABANDONED ASSISTANT" } : row,
                ),
              );
              setSuspend(true);
            });
          }}
        >
          Pending render
        </button>
        <button
          data-testid="cancel-pending"
          onClick={() => {
            setRows(beforeAttempt.current);
            setSuspend(false);
          }}
        >
          Cancel pending
        </button>
        <button data-testid="clock" onClick={() => setRevision((value) => value + 1)}>
          Clock
        </button>
        <button
          data-testid="replace"
          onClick={() =>
            setRows((current) =>
              current.map((row) =>
                row.rowId === 3002 ? { ...row, text: "IMMUTABLE REPLACED ASSISTANT" } : row,
              ),
            )
          }
        >
          Replace
        </button>
        <button
          data-testid="prepend"
          onClick={() => setRows((current) => [...makeTurn(0, 2700), ...current])}
        >
          Prepend
        </button>
        <button data-testid="locale" onClick={() => setLocale("zh-CN")}>
          Locale
        </button>
        <button
          data-testid="session"
          onClick={() => {
            setSessionKey("beta");
            setRows(
              Array.from({ length: 100 }, (_, index) =>
                makeTurn(index + 1, 3000 + index * ROWS_PER_TURN, "beta"),
              ).flat(),
            );
          }}
        >
          Session
        </button>
        <button
          data-testid="running"
          onClick={() =>
            setRows((current) =>
              current.map((row) => (row.rowId === 3297 ? { ...row, state: "running" } : row)),
            )
          }
        >
          Running
        </button>
        <output data-testid="revision">{revision}</output>
        <output data-testid="actions">{JSON.stringify(actions)}</output>
      </div>
      <React.Suspense fallback={<div data-testid="pending-fallback">Pending</div>}>
        <ConversationTurnNavigator
          sessionKey={sessionKey}
          renderUnits={units}
          scrollOffsetPx={0}
          viewportHeightPx={1000}
          virtualItems={virtualItems}
          onJumpToQuery={(target) => jump(target)}
        />
        <SuspendAfterNavigator active={suspend} />
      </React.Suspense>
    </>
  );
}

createRoot(document.getElementById("root")).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </ZCodeIntlProvider>,
);
