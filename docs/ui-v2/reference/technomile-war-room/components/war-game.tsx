"use client";

import { ChatCircleText, Eye, Sword, UserFocus } from "@phosphor-icons/react";
import { Tabs } from "radix-ui";
import { useState } from "react";

import { Pill } from "@/components/ui/pill";
import { cn } from "@/lib/cn";
import type { AgentCitation } from "@/lib/contracts/run-events";
import { ACTIVE_RUN_STATES } from "@/lib/war-room/state";
import { finalPosition, interviewOf, type SwarmGroup, type SwarmItem, type SwarmView } from "@/lib/war-room/swarm";

import { BoardTable, CiteChips, MessageCard, RoleIcon, shortName } from "./swarm-panel";
import { useSwarm } from "./use-swarm";

interface Cited {
  text: string;
  codes: string[];
}

const BID: Record<string, string> = { bid_as_prime: "Bids as prime", team_as_sub: "Teams as a sub", no_bid: "Does not bid" };

function points(m: SwarmItem | null | undefined, key: string): Cited[] {
  const raw = m?.data[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter((p): p is Cited => typeof p === "object" && p !== null && typeof (p as Cited).text === "string" && Array.isArray((p as Cited).codes));
}

/** The answer to challenge i: the data part's answers are aligned with the challenges (null = unanswered). */
function answerAt(m: SwarmItem | null | undefined, i: number): Cited | null {
  const raw = m?.data.answers;
  const a: unknown = Array.isArray(raw) ? raw[i] : null;
  return typeof a === "object" && a !== null && typeof (a as Cited).text === "string" && Array.isArray((a as Cited).codes) ? (a as Cited) : null;
}

function str(m: SwarmItem | null | undefined, key: string): string {
  const v = m?.data[key];
  return typeof v === "string" ? v : "";
}

/** The War game page of a live run: each rival's role-play, the red team's challenges and answers, the interview. */
export function WarGame({ runId }: { runId: string }) {
  const { view, status, error, loaded } = useSwarm(runId);
  const rivals = view.groups.filter((g) => g.kind === "rival");
  const [tab, setTab] = useState<string>("");
  const active = tab || rivals[0]?.id || "";
  if (!loaded) return <p className="text-sm text-muted">Reading the swarm&apos;s record...</p>;
  if (error && view.messages.length === 0) return <p className="text-sm text-danger">The war game could not be read ({error}).</p>;
  if (rivals.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-hairline-strong px-5 py-6 text-sm text-muted">
        {ACTIVE_RUN_STATES.has(status) ? "The war game runs at S9 Role-play and S10 Board; it appears here as the agents work." : "This run recorded no war game."}
      </div>
    );
  }
  return (
    <div>
      <p className="mb-4 max-w-[90ch] rounded-md border border-cream-edge bg-cream px-3 py-2 text-sm text-ink">
        Simulation for a competitor review. Every line is a persona&apos;s, written only from that rival&apos;s accepted claims; it is not a statement by
        the firm. A point without an accepted citation was dropped; an interview line that failed the check is withheld and counted.
      </p>
      <Tabs.Root value={active} onValueChange={setTab}>
        <Tabs.List aria-label="Rivals" className="flex gap-1 overflow-x-auto border-b border-hairline">
          {rivals.map((g) => (
            <Tabs.Trigger
              key={g.id}
              value={g.id}
              className="-mb-px inline-flex h-10 shrink-0 items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium text-muted transition-colors hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink"
            >
              {shortName(g.label)}
              {view.board?.rows.find((r) => r.group === g.id)?.incumbent && <span className="text-micro font-semibold text-accent">incumbent</span>}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {rivals.map((g) => (
          <Tabs.Content key={g.id} value={g.id} className="pt-5 focus-visible:outline-none">
            <RivalGame view={view} group={g} />
          </Tabs.Content>
        ))}
      </Tabs.Root>
      {view.board && <BoardTable board={view.board} />}
    </div>
  );
}

function RivalGame({ view, group }: { view: SwarmView; group: SwarmGroup }) {
  const thread = view.messages.filter((m) => m.contextId === group.id);
  const final = finalPosition(view, group.id);
  const challenge = thread.find((m) => m.kind === "challenge" && m.state === "completed");
  const response = thread.find((m) => m.kind === "response" && m.state === "completed");
  const interview = thread.find((m) => m.kind === "interview" && m.state === "completed");
  const briefs = thread.filter((m) => m.kind === "brief");
  const cites = new Map<string, AgentCitation>();
  for (const m of thread) for (const c of m.citations) cites.set(c.code, c);
  const failed = thread.filter((m) => m.state !== "completed");
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      <div className="flex flex-col gap-5">
        <section aria-label="Final strategy" className="rounded-lg border border-hairline bg-canvas px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{group.label}: simulated bid strategy</h3>
            {final && <Pill tone="ink">{BID[str(final, "bidDecision")] ?? str(final, "bidDecision")}</Pill>}
            {final && <Pill tone="outline">price posture: {str(final, "pricingPosture")}</Pill>}
            {final?.kind === "response" && <Pill tone="cream">revised after the red team</Pill>}
          </div>
          {final ? (
            <>
              <CitedList title="Win themes" items={points(final, "winThemes")} cites={cites} />
              <CitedList title="Weak points it fears" items={points(final, "fears")} cites={cites} />
              {str(final, "teaming") && <p className="mt-3 text-sm text-ink-2">Teaming: {str(final, "teaming")}</p>}
            </>
          ) : (
            <p className="mt-2 text-sm text-muted">No strategy survived: {failed.at(-1)?.text ?? "no cited win theme."}</p>
          )}
        </section>
        <section aria-label="Red team" className="rounded-lg border border-hairline bg-canvas">
          <h3 className="flex items-center gap-2 border-b border-hairline px-4 py-2.5 text-sm font-semibold text-ink">
            <Sword size={16} weight="duotone" aria-hidden /> Red-team challenges and the capture lead&apos;s answers
          </h3>
          {challenge && points(challenge, "points").length === 0 && (
            <p className="px-4 py-3 text-sm text-muted">The red team raised no challenge that cites this rival&apos;s accepted claims (dropped: {challenge.dropped}).</p>
          )}
          {challenge ? (
            <ol className="divide-y divide-hairline-soft">
              {points(challenge, "points").map((c, i) => {
                const answer = answerAt(response, i);
                return (
                  <li key={c.text} className="grid gap-2 px-4 py-3 md:grid-cols-2">
                    <div>
                      <div className="text-micro font-semibold uppercase tracking-[0.06em] text-danger">Challenge {i + 1}</div>
                      <p className="mt-1 text-sm text-ink">{c.text}</p>
                      <CiteChips cites={c.codes.map((k) => cites.get(k)).filter((x): x is AgentCitation => !!x)} />
                    </div>
                    <div>
                      <div className="text-micro font-semibold uppercase tracking-[0.06em] text-muted">Answer</div>
                      {answer ? (
                        <>
                          <p className="mt-1 text-sm text-ink-2">{answer.text}</p>
                          <CiteChips cites={answer.codes.map((k) => cites.get(k)).filter((x): x is AgentCitation => !!x)} />
                        </>
                      ) : (
                        <p className="mt-1 text-sm text-muted">Left unanswered (the board sees that).</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="px-4 py-3 text-sm text-muted">No challenge recorded for this rival.</p>
          )}
        </section>
        <Interview persona={group.label} m={interview ?? null} cites={cites} />
      </div>
      <aside aria-label="Team briefs" className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-ink">The capture team&apos;s briefs (round 1)</h3>
        {briefs.map((m) => (
          <MessageCard key={m.messageId} view={view} m={m} />
        ))}
        <p className="text-xs text-muted">
          Team: {group.agents.map((a) => a.name.split(",")[0]).join(", ")}. Every agent read only: {group.agents[0]?.reads ?? "its rival's accepted claims"}.
        </p>
      </aside>
    </div>
  );
}

function CitedList({ title, items, cites }: { title: string; items: Cited[]; cites: Map<string, AgentCitation> }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-muted">{title}</div>
      <ul className="mt-1 flex flex-col gap-2">
        {items.map((p) => (
          <li key={p.text} className="text-sm text-ink">
            {p.text}
            <CiteChips cites={p.codes.map((k) => cites.get(k)).filter((x): x is AgentCitation => !!x)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** REQ-WAR-08: in character, answers only from accepted claims; a line that failed the check is withheld and counted. */
function Interview({ persona, m, cites }: { persona: string; m: SwarmItem | null; cites: Map<string, AgentCitation> }) {
  const [broken, setBroken] = useState(false);
  const turns = interviewOf(m);
  return (
    <section aria-label="Interview" className="rounded-lg border border-hairline bg-canvas">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-2.5">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <UserFocus size={16} weight="duotone" aria-hidden /> {broken ? "Out of character: the evidence" : `Interview: ${shortName(persona)}'s capture lead, in character`}
        </h3>
        <button
          type="button"
          aria-pressed={broken}
          onClick={() => setBroken((b) => !b)}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm", broken ? "border-ink bg-ink text-on-ink" : "border-hairline-strong text-ink hover:bg-surface-2")}
        >
          <Eye size={14} aria-hidden /> Break character
        </button>
      </div>
      {turns.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted">No interview recorded for this rival.</p>
      ) : (
        <ol className="divide-y divide-hairline-soft">
          {turns.map((t) => (
            <li key={t.question} className="px-4 py-3">
              <div className="flex items-start gap-2 text-sm font-medium text-ink">
                <ChatCircleText size={16} className="mt-0.5 shrink-0" aria-hidden />
                <span>
                  <span className="text-muted">Analyst: </span>
                  {t.question}
                </span>
              </div>
              {t.withheld > 0 && (
                <p className="mt-2 rounded-sm bg-danger-soft px-2 py-1 text-xs font-semibold text-danger">
                  {t.withheld} statement{t.withheld === 1 ? "" : "s"} withheld: not verified
                </p>
              )}
              <ul className="mt-2 flex flex-col gap-2 pl-6">
                {t.statements.length === 0 && t.withheld === 0 && <li className="text-sm text-muted">No answer the evidence supports.</li>}
                {t.statements.map((s) => (
                  <li key={s.text} className="text-sm animate-fade-in">
                    {broken ? (
                      <ul className="flex flex-col gap-1">
                        {s.codes.map((k) => (
                          <li key={k} className="text-ink-2">
                            <span className="mr-1.5 rounded-sm border border-cream-edge bg-cream px-1 font-mono text-micro">{k}</span>
                            {cites.get(k)?.text ?? "accepted claim"}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <>
                        <span className="flex items-start gap-1.5 text-ink">
                          <RoleIcon role="capture_lead" />
                          &ldquo;{s.text}&rdquo;
                        </span>
                        <CiteChips cites={s.codes.map((k) => cites.get(k)).filter((x): x is AgentCitation => !!x)} />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
