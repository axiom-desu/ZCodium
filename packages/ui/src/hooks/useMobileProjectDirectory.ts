import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileProjectRoot } from "@zcode/services";
import type { ZCodeTaskCreateResult } from "@zcode/shared";

export interface MobileProjectDirectoryPort {
  readProjectDirectory(workspaceKey: string): Promise<MobileProjectRoot[] | null>;
  createProjectTask(root: MobileProjectRoot): Promise<ZCodeTaskCreateResult>;
}

/** Local entry projection only; bridge/source epochs remain owned by the Host/client. */
export function useMobileProjectDirectory(
  port: MobileProjectDirectoryPort | null,
  workspaceKey: string | undefined,
  active: boolean,
  entryEpoch?: object,
) {
  const [roots, setRoots] = useState<MobileProjectRoot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const epoch = useRef(0);
  useEffect(() => {
    const current = ++epoch.current;
    setRoots(null);
    setError(null);
    setPending(false);
    if (active && port && workspaceKey) {
      void port
        .readProjectDirectory(workspaceKey)
        .then((rows) => {
          if (epoch.current === current) setRoots(rows);
        })
        .catch((reason: unknown) => {
          if (epoch.current === current)
            setError(reason instanceof Error ? reason.message : String(reason));
        });
    }
    return () => {
      epoch.current++;
    };
  }, [port, workspaceKey, active, entryEpoch]);
  const inFlight = useRef(false);
  const create = useCallback(
    async (root: MobileProjectRoot) => {
      if (!active || !port || !root.enabled || inFlight.current) return null;
      const current = epoch.current;
      inFlight.current = true;
      setPending(true);
      setError(null);
      try {
        const result = await port.createProjectTask(root);
        return current === epoch.current ? result : null;
      } catch (reason) {
        if (current === epoch.current)
          setError(reason instanceof Error ? reason.message : String(reason));
        return null;
      } finally {
        inFlight.current = false;
        if (current === epoch.current) setPending(false);
      }
    },
    [port, active],
  );
  return { roots, error, pending, create };
}
