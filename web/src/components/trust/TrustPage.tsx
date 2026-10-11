/**
 * The trust center (S6 4.11): isolation, commitments, fairness, methodology, budget and observability, each a
 * plain page. Fixed content (the metric catalog, the capability matrix, the method text, the cap) is bundled and
 * checked against its sources; server values appear only as the server reports them, and a section whose route
 * the server does not offer yet says so. EX-4 heads every page; the methodology page carries the EVL-10 and
 * EVL-12 sentences with the NIST link (FE-TRUST-2).
 */
import { useState, type ReactNode } from "react";

import type { Capability } from "../../lib/trust/capability";
import type { CommitmentRow, IsolationRun } from "../../lib/trust/sections";
import type { TrustBudget } from "../../lib/trust/budget";
import type { Verdict } from "../../lib/trust/commitment";
import { CAP_USD, TARGET_USD } from "../../lib/trust/budget";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { METRICS } from "../../lib/copy/metrics";

export const SECTIONS = [
  ["isolation", "Isolation"],
  ["commitments", "Commitments"],
  ["fairness", "Fairness audit"],
  ["methodology", "Methodology"],
  ["budget", "Budget"],
  ["observability", "Observability"],
] as const;

export type SectionId = (typeof SECTIONS)[number][0];

export type Load<T> = { readonly state: "loading" } | { readonly state: "missing" } | { readonly state: "error" } | { readonly state: "ready"; readonly value: T };

export const NOT_CERTIFICATION = "A tournament rank is not certification for real investigations.";
export const NIST_STATEMENT = "The thresholds are the proposal's own; NIST has not validated them.";
export const NIST_URL = "https://airc.nist.gov/airmf-resources/playbook/measure/";

function Unavailable({ load }: { load: Load<unknown> }) {
  if (load.state === "loading") return <p className="fine">Loading.</p>;
  if (load.state === "missing") return <p className="empty">The server does not publish this yet.</p>;
  if (load.state === "error") return <p className="empty">This could not be read.</p>;
  return null;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel console-card" aria-label={title}>
      <header className="panel-head">
        <h2>{title}</h2>
      </header>
      <div className="panel-body trust-body">{children}</div>
    </section>
  );
}

function Isolation({ matrix, runs }: { matrix: readonly Capability[]; runs: Load<readonly IsolationRun[]> }) {
  return (
    <>
      <Card title="Latest gate runs">
        <p>The isolation gate&apos;s checks: database privilege tests, direct calls to the subject and referee processes with the wrong credential, the coach-context type test, the hidden-split seal, commitment verification and the canary audit. The latest run of each is shown with its result, never its evidence.</p>
        <Unavailable load={runs} />
        {runs.state === "ready" ? (
          <table className="board">
            <thead>
              <tr>
                <th scope="col">Check</th>
                <th scope="col">Candidate</th>
                <th scope="col">Result</th>
                <th scope="col">Run</th>
                <th scope="col">Commit</th>
              </tr>
            </thead>
            <tbody>
              {runs.value.map((r, i) => (
                <tr key={`${r.check}-${String(i)}`}>
                  <td className="mono">{r.check}</td>
                  <td>{r.candidate ?? "all"}</td>
                  <td>{r.passed ? "pass" : "fail"}</td>
                  <td>{r.ranAt ?? ""}</td>
                  <td className="mono">{r.commitSha?.slice(0, 12) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      <Card title="Capability matrix">
        <p>What each database role may do, from the same file the database tests check on every change ({matrix.length} rows). The subject and referee processes each run under their own role.</p>
        <table className="board capability">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Object</th>
              <th scope="col">Privilege</th>
              <th scope="col">Expected</th>
            </tr>
          </thead>
          <tbody>
            {matrix.map((r, i) => (
              <tr key={i}>
                <td className="mono">{r.role}</td>
                <td>
                  <span className="fine">{r.objectType}</span> <span className="mono">{r.object}</span>
                </td>
                <td className="mono">{r.privilege}</td>
                <td>{r.expect}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function VerifyForm({ verify }: { verify: (nonce: string, payload: string, commitment: string) => Promise<Verdict> }) {
  const [nonce, setNonce] = useState("");
  const [payload, setPayload] = useState("");
  const [commitment, setCommitment] = useState("");
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  return (
    <form
      className="verify-form"
      onSubmit={(e) => {
        e.preventDefault();
        void verify(nonce, payload, commitment).then(setVerdict);
      }}
    >
      <label className="field">
        <span>Nonce (64 hex characters)</span>
        <input
          className="mono"
          value={nonce}
          onChange={(e) => {
            setNonce(e.target.value);
            setVerdict(null);
          }}
        />
      </label>
      <label className="field">
        <span>Payload text</span>
        <textarea
          className="mono"
          rows={3}
          value={payload}
          onChange={(e) => {
            setPayload(e.target.value);
            setVerdict(null);
          }}
        />
      </label>
      <label className="field">
        <span>Published commitment (sha256)</span>
        <input
          className="mono"
          value={commitment}
          onChange={(e) => {
            setCommitment(e.target.value);
            setVerdict(null);
          }}
        />
      </label>
      <button type="submit" className="btn-secondary-sm">
        Verify in browser
      </button>
      {verdict === null ? null : (
        <p role="status" data-verdict={verdict}>
          {verdict === "match" ? "Match: the commitment is the hash of this nonce and payload." : verdict === "mismatch" ? "Mismatch: the commitment is not the hash of this nonce and payload." : "Not checkable: the nonce must be 32 bytes of hex and the commitment a sha256."}
        </p>
      )}
    </form>
  );
}

function RowVerify({ row, verify }: { row: CommitmentRow; verify: (nonce: string, payload: string, commitment: string) => Promise<Verdict> }) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  if (row.nonce === null || row.payloadText === null) return <span className="fine">after reveal</span>;
  const { nonce, payloadText } = row;
  return verdict === null ? (
    <button
      type="button"
      className="btn-secondary-sm"
      onClick={() => {
        void verify(nonce, payloadText, row.commitment).then(setVerdict);
      }}
    >
      Verify in browser
    </button>
  ) : (
    <span data-verdict={verdict}>{verdict}</span>
  );
}

function Commitments({ rows, verify }: { rows: Load<readonly CommitmentRow[]>; verify: (nonce: string, payload: string, commitment: string) => Promise<Verdict> }) {
  return (
    <>
      <Card title="Commitments">
        <p>When a trial ends, the finding is hashed with a secret 32-byte nonce: commitment = sha256(nonce followed by the finding&apos;s stored text). The hash is published at once; the nonce and the text are published at reveal, so anyone can recompute the hash and see that no finding changed after the fact.</p>
        <Unavailable load={rows} />
        {rows.state === "ready" && rows.value.length === 0 ? <p className="empty">No commitments published.</p> : null}
        {rows.state === "ready" && rows.value.length > 0 ? (
          <table className="board">
            <thead>
              <tr>
                <th scope="col">Trial</th>
                <th scope="col">Commitment</th>
                <th scope="col">Transcript hash</th>
                <th scope="col">Check</th>
              </tr>
            </thead>
            <tbody>
              {rows.value.map((r) => (
                <tr key={r.trial}>
                  <td className="mono">{r.trial}</td>
                  <td className="mono hash">{r.commitment}</td>
                  <td className="mono">{r.transcriptSha?.slice(0, 16) ?? ""}</td>
                  <td>
                    <RowVerify row={r} verify={verify} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>
      <Card title="Check one yourself">
        <p className="fine">Paste a revealed trial&apos;s nonce, payload text and commitment. The hash is computed in this browser; nothing is sent.</p>
        <VerifyForm verify={verify} />
      </Card>
    </>
  );
}

function Fairness({ load }: { load: Load<unknown> }) {
  return (
    <Card title="Fairness audit">
      <p>Each case variant has a communication style, assigned by design independently of whether the subject is truthful. The audit compares each coach&apos;s false-positive rate and flag rate across styles, counts flags and findings that rest on demeanor rather than content (any count above zero is shown next to the rank), and tests the differences by permutation. Negative controls (recorded demeanor-driven coaching on the same content in two styles) show that the audit catches demeanor-based outputs. With this sample size a non-significant result means &quot;not detected&quot;, never &quot;no bias&quot;.</p>
      <Unavailable load={load} />
      {load.state === "ready" ? <p className="fine">Results are published with the revealed tournament&apos;s leaderboards.</p> : null}
    </Card>
  );
}

function Methodology() {
  return (
    <>
      <Card title="What is measured">
        <p>
          {NIST_STATEMENT}{" "}
          <a href={NIST_URL} rel="noreferrer" target="_blank">
            NIST AI RMF Playbook, Measure function
          </a>
          .
        </p>
        <p>{NOT_CERTIFICATION}</p>
        <table className="board metrics">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              <th scope="col">Estimand</th>
              <th scope="col">Unit</th>
              <th scope="col">Interval</th>
              <th scope="col">Tracks</th>
              <th scope="col">Edge cases</th>
            </tr>
          </thead>
          <tbody>
            {METRICS.map((m) => (
              <tr key={m.id}>
                <td>
                  <span className="mono">{m.id}</span> {m.metric}
                </td>
                <td>{m.estimand}</td>
                <td>{m.unit}</td>
                <td>{m.interval}</td>
                <td className="mono">{m.tracks}</td>
                <td>{m.edge}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="fine">Tracks: I interactive, R replay, T training. Intervals are percentile bootstraps over case families (10,000 resamples, seeded from the manifest hash), except KPI-1 (participant bootstrap) and coaching latency (session bootstrap); gate comparisons use exact fractions.</p>
      </Card>
      <Card title="Eligibility, ranking and attrition">
        <ul>
          <li>A coach is ranked only if its false-positive rate on its own included truthful trials is at most 5% and the isolation gate passed. Another coach&apos;s failures never change this coach&apos;s eligibility.</li>
          <li>Eligible coaches are ordered by deceptive-role recall, then questioning quality. The rank interval shows where each coach falls across bootstrap resamples; overlapping intervals mean the order is uncertain, not tied.</li>
          <li>Excluded truthful trials are imputed both ways, as false positives and as clears. If the point, worst and best cases fall on different sides of 5%, eligibility is marked provisional.</li>
          <li>A trial the coach failed to finish counts as an insufficient-evidence finding, so it is not imputed.</li>
        </ul>
      </Card>
      <Card title="When nothing goes wrong">
        <p>A false-positive rate of zero does not mean the true rate is zero. With no failures in n complete case families, the page shows the exact one-sided 95% upper bound 1 - 0.05^(1/n): for 15 families that is 18.1%. The server prints the bound for the actual count.</p>
      </Card>
      <Card title="How scores are checked">
        <p>The referee&apos;s scores are compared with blinded human raters, who fill the same yes/no checks and never enter a score themselves. A dimension is accepted when quadratic-weighted kappa is at least 0.60 and Gwet&apos;s AC2 at least 0.70; labels and flag support need kappa at least 0.60 and AC1 at least 0.70. Results are published with the calibration report.</p>
      </Card>
      <Card title="NIST AI RMF, Measure function">
        <ul>
          <li>Documented test methods: every metric&apos;s estimand, unit and interval method is on this page and in the specification.</li>
          <li>Context-specific measurement: synthetic facility-access interviews with locked case facts and scripted evidence.</li>
          <li>Independent assessment: the referee runs apart from the coaches and subjects, and blinded human raters check it.</li>
        </ul>
      </Card>
    </>
  );
}

function Budget({ load }: { load: Load<TrustBudget> }) {
  return (
    <Card title="Budget">
      <p>
        The project&apos;s model spend is capped at ${CAP_USD} with a target of ${TARGET_USD}. Every model call reserves its worst-case cost against one ceiling before it is sent, and the kill switch is read in the same step.
      </p>
      <Unavailable load={load} />
      {load.state === "ready" && !load.value.applied ? <p className="empty">Budget plan not applied: no model spend is possible.</p> : null}
      {load.state === "ready" && load.value.applied ? (
        <>
          <p>
            Applied ceiling {load.value.ceiling}; spent so far {load.value.spent}
            {load.value.plannedCases === null ? "" : `; planned cases ${String(load.value.plannedCases)}`}.
          </p>
          {load.value.byPurpose.length === 0 ? null : (
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">Purpose</th>
                  <th scope="col">Spent</th>
                </tr>
              </thead>
              <tbody>
                {load.value.byPurpose.map((p) => (
                  <tr key={p.purpose}>
                    <td>{p.purpose}</td>
                    <td>{p.spent}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : null}
    </Card>
  );
}

function Observability({ phoenix }: { phoenix: string | null }) {
  return (
    <Card title="Observability">
      <p>Every model call, retry and coaching step is traced locally with Arize Phoenix, running on the operator&apos;s machine. Latency for the coach&apos;s cards (KPI-4) is measured from the database clock and published with each leaderboard.</p>
      {phoenix === null ? (
        <p className="fine">The local Phoenix address is not configured on this server.</p>
      ) : (
        <p className="fine">
          Operators: <a href={phoenix}>open local Phoenix</a>.
        </p>
      )}
    </Card>
  );
}

export interface TrustPageProps {
  readonly section: SectionId;
  readonly matrix: readonly Capability[];
  readonly isolation: Load<readonly IsolationRun[]>;
  readonly commitments: Load<readonly CommitmentRow[]>;
  readonly fairness: Load<unknown>;
  readonly budget: Load<TrustBudget>;
  readonly phoenix: string | null;
  readonly verify: (nonce: string, payload: string, commitment: string) => Promise<Verdict>;
}

export function TrustPage(props: TrustPageProps) {
  return (
    <div className="console-page trust-page">
      <header className="console-top">
        <span className="eyebrow">Training arena</span>
        <h1>Trust center</h1>
        <a className="fine" href="/">
          Back to the precinct
        </a>
      </header>
      <p className="fine">{EX4_TEXT}</p>
      <nav className="trust-nav" aria-label="Trust center sections">
        {SECTIONS.map(([id, name]) => (
          <a key={id} href={`/trust/${id}`} aria-current={props.section === id ? "page" : undefined}>
            {name}
          </a>
        ))}
      </nav>
      {props.section === "isolation" ? <Isolation matrix={props.matrix} runs={props.isolation} /> : null}
      {props.section === "commitments" ? <Commitments rows={props.commitments} verify={props.verify} /> : null}
      {props.section === "fairness" ? <Fairness load={props.fairness} /> : null}
      {props.section === "methodology" ? <Methodology /> : null}
      {props.section === "budget" ? <Budget load={props.budget} /> : null}
      {props.section === "observability" ? <Observability phoenix={props.phoenix} /> : null}
    </div>
  );
}
