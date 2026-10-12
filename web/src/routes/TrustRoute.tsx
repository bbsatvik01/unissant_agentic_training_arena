/**
 * `/trust` and `/trust/:section` (S6 2.2, 4.11): the trust center for everyone. The fixed parts are bundled (the
 * capability matrix from the database tests' own fixture); the server parts are read from `GET /api/trust/{section}`
 * and `GET /api/config`, and a section the server does not publish yet says so.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router";

import csv from "../../../supabase/tests/fixtures/capability_matrix.csv?raw";
import { SECTIONS, TrustPage, type Load, type SectionId } from "../components/trust/TrustPage";
import { ApiError, createApiClient } from "../lib/api/client";
import { createTrustApi, type TrustSection } from "../lib/api/trust";
import { parseTrustBudget } from "../lib/trust/budget";
import { parseCapabilities } from "../lib/trust/capability";
import { verifyCommitment } from "../lib/trust/commitment";
import { parseCalibration, parseFairness } from "../lib/trust/fairness";
import { parseCommitments, parseIsolation, phoenixUrl } from "../lib/trust/sections";

const MATRIX = parseCapabilities(csv);

function useSection<T>(read: (s: TrustSection) => Promise<unknown>, section: TrustSection, active: boolean, parse: (v: unknown) => T | null): Load<T> {
  const [load, setLoad] = useState<Load<T>>({ state: "loading" });
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    read(section).then(
      (raw) => {
        if (cancelled) return;
        const value = parse(raw);
        setLoad(value === null ? { state: "error" } : { state: "ready", value });
      },
      (e: unknown) => {
        if (!cancelled) setLoad(e instanceof ApiError && e.status === 404 ? { state: "missing" } : { state: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [read, section, active, parse]);
  return load;
}

export function TrustRoute() {
  const params = useParams();
  const section: SectionId = SECTIONS.find(([id]) => id === params["section"])?.[0] ?? "methodology";
  const api = useMemo(() => createTrustApi(createApiClient()), []);
  const isolation = useSection(api.section, "isolation", section === "isolation", parseIsolation);
  const commitments = useSection(api.section, "commitments", section === "commitments", parseCommitments);
  const fairness = useSection(api.section, "fairness", section === "fairness", parseFairness);
  const calibration = useSection(api.section, "methodology", section === "methodology", parseCalibration);
  const budget = useSection(api.section, "budget", section === "budget", parseTrustBudget);
  const [phoenix, setPhoenix] = useState<string | null>(null);
  useEffect(() => {
    if (section !== "observability") return;
    let cancelled = false;
    api.config().then(
      (c) => {
        if (!cancelled) setPhoenix(phoenixUrl(c));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [api, section]);
  return <TrustPage section={section} matrix={MATRIX} isolation={isolation} commitments={commitments} fairness={fairness} calibration={calibration} budget={budget} phoenix={phoenix} verify={verifyCommitment} />;
}
