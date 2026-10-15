/** Four donor-inspired stages, one public trial projection. No transport, timers or private case data. */
import { useId } from "react";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { between, officePoint, STYLE_NAMES, WORK_STYLES, type Point, type WorkAgent, type WorkFrame, type WorkItem, type WorkRole, type WorkStyle } from "../../lib/agent-work/model";
import "../../styles/agent-work.css";

export interface AgentWorkMonitorProps {
  readonly frame: WorkFrame;
  readonly style: WorkStyle;
  readonly size?: "thumbnail" | "full";
  readonly onExpand?: () => void;
  readonly onStyleChange?: (style: WorkStyle) => void;
  /** Open an existing public card, transcript turn, evidence record or debrief. No data is fetched here. */
  readonly onInspect?: (item: WorkItem) => void;
}
const ROLES: Readonly<Record<WorkRole, { color: string; initial: string }>> = {
  subject: { color: "#506b85", initial: "S" }, coach: { color: "#427866", initial: "C" },
  evidence: { color: "#ad8152", initial: "E" }, referee: { color: "#82638a", initial: "R" },
};
const STATUS: Readonly<Record<WorkAgent["status"], string>> = {
  waiting: "Waiting", working: "Working", ready: "Filed", withheld: "Withheld", failed: "Unavailable",
};
const polygon = (points: readonly Point[]) => points.map((point) => `${String(point.x)},${String(point.y)}`).join(" ");
function ShortText({ x, y, text, limit = 30, className = "awm-svg-note" }: { readonly x: number; readonly y: number; readonly text: string; readonly limit?: number; readonly className?: string }) {
  const short = text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
  return <text x={x} y={y} className={className}>{short}</text>;
}
function Paper({ x, y, w = 58, h = 40, lines = 3 }: { readonly x: number; readonly y: number; readonly w?: number; readonly h?: number; readonly lines?: number }) {
  return <g><rect x={x + 2} y={y + 3} width={w} height={h} rx="2" fill="#253b3620" /><rect x={x} y={y} width={w} height={h} rx="2" className="awm-paper" />{Array.from({ length: lines }, (_, i) => <path key={i} d={`M${String(x + 8)} ${String(y + 10 + i * 8)}h${String(w - 18 - (i % 2) * 8)}`} className="awm-paper-rule" />)}</g>;
}
function Person({ x, y, agent, phase, scale = 1 }: { readonly x: number; readonly y: number; readonly agent: WorkAgent; readonly phase: number; readonly scale?: number }) {
  const role = ROLES[agent.id];
  const working = agent.status === "working";
  const offset = working ? Math.sin(phase * Math.PI * 2) * 2 : 0;
  return <g transform={`translate(${String(x)} ${String(y)}) scale(${String(scale)})`} data-agent={agent.id}>
    <ellipse cx="0" cy="4" rx="24" ry="7" fill="#1a30241a" />
    <g className="awm-gesture" style={{ transform: `translateY(${String(offset)}px)` }}>
      <path d="M-12-14-15 0M12-14 15 0" stroke="#293b43" strokeWidth="8" strokeLinecap="round" />
      <path d="M-17-46Q0-55 17-46L21-15Q0-8-21-15Z" fill={role.color} stroke="#ffffff" strokeWidth="2" />
      <path d="M-16-40-25-24M16-40 27-27" stroke={role.color} strokeWidth="9" strokeLinecap="round" />
      <circle cy="-66" r="17" fill="#e4bea2" stroke="#ffffff" strokeWidth="2" />
      <path d="M-16-69Q-13-91 7-82Q20-77 17-68L8-73Q-6-68-16-69" fill="#32434a" />
      <text x="0" y="-27" textAnchor="middle" fill="white" fontSize="13" fontWeight="700">{role.initial}</text>
    </g>
    {working ? <g className="awm-work-signal"><rect x="21" y="-94" width="39" height="20" rx="10" fill="white" stroke={role.color} /><text x="40" y="-80" fontSize="13" textAnchor="middle" fill={role.color}>···</text></g> : null}
    {agent.status === "withheld" ? <g><rect x="-15" y="-34" width="30" height="24" rx="3" fill="#52605f" /><path d="M-8-34v-6a8 8 0 0 1 16 0v6" fill="none" stroke="white" strokeWidth="2" /></g> : null}
  </g>;
}
function Packets({ frame, positions }: { readonly frame: WorkFrame; readonly positions: Readonly<Record<WorkRole, Point>> }) {
  return <g className="awm-moving">{frame.transfers.slice(-6).map((transfer) => {
    const from = positions[transfer.from];
    const to = positions[transfer.to];
    const at = between(from, to, transfer.progress);
    return <g key={transfer.id}><path d={`M${String(from.x)} ${String(from.y)}Q${String((from.x + to.x) / 2)} ${String(Math.min(from.y, to.y) - 50)} ${String(to.x)} ${String(to.y)}`} fill="none" stroke="#477f74" strokeDasharray="4 7" opacity=".45" /><g transform={`translate(${String(at.x)} ${String(at.y - Math.sin(transfer.progress * Math.PI) * 32)})`}><rect x="-11" y="-7" width="22" height="14" rx="2" fill="#fffefa" stroke="#346d61" /><path d="m-10-6 10 8 10-8" fill="none" stroke="#346d61" /></g></g>;
  })}</g>;
}
function IsoBox({ x, y, w, d, h, z = 0, tone = "#d7c3a3" }: { readonly x: number; readonly y: number; readonly w: number; readonly d: number; readonly h: number; readonly z?: number; readonly tone?: string }) {
  const a = officePoint(x, y, z), b = officePoint(x + w, y, z), c = officePoint(x + w, y + d, z), e = officePoint(x, y + d, z);
  return <g stroke="#677b7455" strokeWidth="1"><polygon points={polygon([e, c, { x: c.x, y: c.y - h }, { x: e.x, y: e.y - h }])} fill="#b4a387" /><polygon points={polygon([b, c, { x: c.x, y: c.y - h }, { x: b.x, y: b.y - h }])} fill="#c6b291" /><polygon points={polygon([a, b, c, e].map((p) => ({ x: p.x, y: p.y - h })))} fill={tone} /></g>;
}
function Office({ frame }: { readonly frame: WorkFrame }) {
  const seats = [{ x: 2.4, y: 2.3 }, { x: 8.2, y: 2.3 }, { x: 2.4, y: 8.3 }, { x: 8.2, y: 8.3 }];
  const positions: Record<WorkRole, Point> = { subject: officePoint(2.4, 2.3, 75), coach: officePoint(8.2, 2.3, 75), evidence: officePoint(2.4, 8.3, 75), referee: officePoint(8.2, 8.3, 75) };
  return <g data-scene="office">
    <rect width="960" height="540" fill="#edf2eb" /><ellipse cx="483" cy="392" rx="380" ry="115" fill="#b0bfb330" />
    <polygon points={polygon([officePoint(0, 0, 120), officePoint(12, 0, 120), officePoint(12, 0), officePoint(0, 0)])} fill="#d6e2d9" />
    <polygon points={polygon([officePoint(0, 0, 120), officePoint(0, 12, 120), officePoint(0, 12), officePoint(0, 0)])} fill="#e7ebe1" />
    <polygon points={polygon([officePoint(0, 0), officePoint(12, 0), officePoint(12, 12), officePoint(0, 12)])} fill="#f9f7ee" stroke="#a8b8aa" />
    {Array.from({ length: 11 }, (_, i) => <g key={i} stroke="#d6ded1" strokeWidth="1"><path d={`M${String(officePoint(i + 1, 0).x)} ${String(officePoint(i + 1, 0).y)}L${String(officePoint(i + 1, 12).x)} ${String(officePoint(i + 1, 12).y)}`} /><path d={`M${String(officePoint(0, i + 1).x)} ${String(officePoint(0, i + 1).y)}L${String(officePoint(12, i + 1).x)} ${String(officePoint(12, i + 1).y)}`} /></g>)}
    <text x="58" y="48" className="awm-scene-title">THE AGENT OFFICE</text><text x="58" y="71" className="awm-svg-note">A desk for every part of the work</text>
    {frame.agents.map((agent, index) => {
      const seat = seats[index]; if (seat === undefined) return null;
      const at = officePoint(seat.x, seat.y);
      return <g key={agent.id}><Person x={at.x} y={at.y - 10} scale={.72} agent={agent} phase={frame.phase} /><IsoBox x={seat.x - 1} y={seat.y + .3} w={3.3} d={1.7} h={32} /><g transform={`translate(${String(at.x - 8)} ${String(at.y - 35)})`}><path d="M0 0 32 16 32-8 0-24Z" fill={agent.status === "working" ? "#386b60" : "#445c61"} stroke="#e7e8de" strokeWidth="3" /><path d="m6-14 19 10m-19-3 14 7" stroke="#bcdfce" strokeWidth="2" /><path d="m16 8v9" stroke="#566961" strokeWidth="3" /></g><rect x={at.x - 64} y={at.y + 46} width="150" height="43" rx="6" fill="#fffef8" stroke="#b9c6ba" /><text x={at.x + 11} y={at.y + 63} textAnchor="middle" className="awm-svg-label">{agent.name}</text><text x={at.x + 11} y={at.y + 79} textAnchor="middle" className="awm-svg-note">{STATUS[agent.status]}</text></g>;
    })}
    <IsoBox x={10.7} y={.5} w={.8} d={.8} h={23} tone="#788e78" />
    <g transform="translate(765 315)"><path d="M0 0v-40" stroke="#637d60" strokeWidth="3" /><ellipse cy="-38" rx="15" ry="26" fill="#769475" /><ellipse cx="-13" cy="-24" rx="10" ry="19" fill="#92aa85" /></g>
    <Packets frame={frame} positions={positions} />
  </g>;
}
function CaseBoard({ frame, id }: { readonly frame: WorkFrame; readonly id: string }) {
  const positions: Record<WorkRole, Point> = { subject: { x: 144, y: 230 }, coach: { x: 385, y: 230 }, evidence: { x: 638, y: 230 }, referee: { x: 827, y: 230 } };
  const cards = frame.items.filter((item) => item.kind === "card" || item.kind === "update").slice(-3);
  const documents = frame.documents.slice(-3);
  return <g data-scene="case-board"><defs><pattern id={`${id}-cork`} width="18" height="18" patternUnits="userSpaceOnUse"><rect width="18" height="18" fill="#c6b18c" /><path d="m2 3 2 1m8 5 2 1M6 15h2" stroke="#a18b67" opacity=".3" /></pattern></defs>
    <rect width="960" height="540" fill="#685b4b" /><rect x="16" y="16" width="928" height="508" rx="7" fill={`url(#${id}-cork)`} stroke="#a28b69" strokeWidth="12" />
    <rect x="42" y="36" width="876" height="52" fill="#f4ecdc" /><text x="60" y="69" className="awm-scene-title">THE CASE BOARD</text><text x="895" y="68" textAnchor="end" className="awm-svg-note">FILED FROM THE SESSION RECORD</text>
    {frame.agents.map((agent, index) => <g key={agent.id}><rect x={52 + index * 221} y="113" width="196" height="352" rx="3" fill="#fcf7eab8" /><text x={66 + index * 221} y="137" className="awm-svg-label">{agent.name.toUpperCase()}</text><path d={`M${String(66 + index * 221)} 148h168`} stroke="#9f8d71" /></g>)}
    <g transform="rotate(-4 146 237)"><rect x="73" y="171" width="145" height="139" fill="#fffdf7" stroke="#c7bcaa" /><rect x="84" y="181" width="123" height="94" fill="#d7e1dc" />{frame.agents[0] === undefined ? null : <Person x={145} y={270} scale={.8} agent={frame.agents[0]} phase={frame.phase} />}<text x="145" y="298" textAnchor="middle" className="awm-svg-note">SUBJECT · T{frame.turn}</text><circle cx="145" cy="174" r="5" fill="#7e5842" /></g>
    <ShortText x={74} y={343} text={frame.agents[0]?.task ?? "Waiting"} limit={24} />
    {cards.length === 0 ? <text x="294" y="209" className="awm-svg-note">{frame.assessment ? "COACHING WITHHELD" : "No cards filed yet"}</text> : cards.map((card, index) => <g key={card.id} transform={`rotate(${String(index % 2 === 0 ? -2 : 2)} 366 ${String(192 + index * 65)})`}><Paper x={292} y={174 + index * 69} w={158} h={56} lines={2} /><text x="302" y={217 + index * 69} className="awm-svg-note">{card.kind === "card" ? "CARD" : "DEEP REVIEW"} · T{card.turn}</text><circle cx="369" cy={179 + index * 69} r="4" fill="#426c5d" /></g>)}
    {frame.documents.length === 0 ? <text x="515" y="209" className="awm-svg-note">Awaiting releases</text> : documents.map((doc, index) => <g key={doc.id}><Paper x={513} y={174 + index * 73} w={158} h={60} lines={1} /><ShortText x={523} y={211 + index * 73} text={doc.title} limit={21} /><circle cx="590" cy={179 + index * 73} r="4" fill="#9b6b46" /></g>)}
    {frame.flags.slice(-2).map((flag, index) => { const cardRow = cards.findIndex((card) => card.turn === flag.turn); const recordRow = documents.findIndex((record) => record.id === flag.recordId); return <g key={flag.id}>{cardRow < 0 || recordRow < 0 ? null : <path d={`M445 ${String(209 + cardRow * 69)}C490 ${String(180 + cardRow * 69)} 486 ${String(209 + recordRow * 73)} 519 ${String(209 + recordRow * 73)}`} fill="none" stroke="#9b6045" strokeWidth="2" />}<rect x="298" y={390 + index * 27} width="366" height="23" fill="#fff7d4" /><text x="309" y={406 + index * 27} className="awm-svg-note">{flag.label} · T{flag.turn} · citation checked</text></g>; })}
    <g transform="rotate(3 812 256)"><Paper x={735} y={183} w={153} h={151} lines={5} /><text x="811" y="299" textAnchor="middle" className="awm-svg-label">REFEREE</text><text x="811" y="319" textAnchor="middle" className="awm-svg-note">{STATUS[frame.refereeState]}</text><circle cx="810" cy="189" r="5" fill="#785e80" /></g>
    <rect x="48" y="480" width="866" height="25" fill="#f4ecdc" /><text x="61" y="498" className="awm-svg-note">{frame.cards} CARDS  /  {frame.updates} UPDATES  /  {frame.documents.length} RELEASED RECORDS  /  {frame.flags.length} CITED FLAGS</text>
    <Packets frame={frame} positions={positions} />
  </g>;
}
function Playhouse({ frame }: { readonly frame: WorkFrame }) {
  const positions: Record<WorkRole, Point> = { subject: { x: 333, y: 333 }, coach: { x: 530, y: 333 }, evidence: { x: 151, y: 333 }, referee: { x: 805, y: 205 } };
  return <g data-scene="playhouse"><rect width="960" height="540" fill="#eee9df" /><rect x="33" y="27" width="894" height="470" rx="140" fill="#d9d2c5" stroke="#b8ae9c" strokeWidth="3" /><path d="M72 441V174Q72 64 186 64h588q114 0 114 110v267" fill="#e9e2d5" stroke="#a8823c" strokeWidth="5" />
    <rect x="89" y="116" width="780" height="314" fill="#ece6da" /><path d="m89 366 780 0 35 76H55Z" fill="#d7c7ac" />{[0, 1, 2, 3].map((i) => <path key={i} d={`M${String(160 + i * 198)} 367l${String((i - 1.5) * 39)} 75`} stroke="#ac9577" />)}
    <path d="M82 91h796v71Q750 117 681 148Q568 111 479 149Q353 111 270 150Q143 116 82 166Z" fill="#1f4e5f" stroke="#12313c" strokeWidth="3" />
    <path d="M88 139q17 106-10 231l79 13q-20-137 3-234Z" fill="#1f4e5f" stroke="#12313c" strokeWidth="3" /><path d="M874 139q-17 106 10 231l-79 13q20-137-3-234Z" fill="#1f4e5f" stroke="#12313c" strokeWidth="3" />
    <rect x="320" y="43" width="320" height="44" rx="22" fill="#faf6e9" stroke="#a8823c" strokeWidth="2" /><text x="480" y="72" textAnchor="middle" className="awm-scene-title">THE PLAYHOUSE</text>
    {frame.agents.map((agent) => {
      const at = positions[agent.id];
      return <g key={agent.id}>{agent.status === "working" ? <path d={`M${String(at.x - 13)} 147h26L${String(at.x + 70)} ${String(at.y + 20)}H${String(at.x - 70)}Z`} fill="#e7cd743b" /> : null}<path d={`M${String(at.x)} 154V${String(at.y - 94)}`} stroke="#8d806a" strokeWidth="1" /><Person x={at.x} y={at.y + 32} scale={agent.id === "referee" ? .72 : 1.04} agent={agent} phase={frame.phase} /><rect x={at.x - 76} y={at.y + 52} width="152" height="41" rx="3" fill="#fdf9ef" stroke="#a99b85" /><text x={at.x} y={at.y + 69} textAnchor="middle" className="awm-svg-label">{agent.name}</text><text x={at.x} y={at.y + 85} textAnchor="middle" className="awm-svg-note">{STATUS[agent.status]}</text></g>;
    })}
    <path d="M727 263h151v14H727Z" fill="#8b6c48" /><rect x="728" y="277" width="149" height="46" fill="#cfba94" /><text x="802" y="305" textAnchor="middle" className="awm-svg-note">CRITICS’ BOX</text>
    <rect x="104" y="251" width="151" height="10" fill="#b3a181" />{frame.documents.slice(-7).map((doc, index) => <rect key={doc.id} x={113 + index * 18} y={222 - index % 2 * 5} width="13" height={29 + index % 2 * 5} fill={index % 2 === 0 ? "#98714e" : "#698776"} stroke="#fff7df" />)}
    <rect x="614" y="311" width="100" height="72" fill="#fbf6e9" stroke="#aa9577" /><text x="664" y="336" textAnchor="middle" className="awm-svg-note">PLAYBILL</text><text x="664" y="357" textAnchor="middle" className="awm-svg-label">TURN {frame.turn}</text><path d="m627 385-9 31m84-31 9 31" stroke="#947b59" strokeWidth="4" />
    <path d="M38 452h884v35H38Z" fill="#a98d68" /><path d="M31 487h898v13H31Z" fill="#80684b" /><text x="480" y="476" textAnchor="middle" fill="#ffffff" fontSize="13" letterSpacing="2">{frame.assessment ? "ASSESSMENT · COACHING REMAINS OFFSTAGE" : "THE RECORDED WORK, ONE EVENT AT A TIME"}</text>
    <Packets frame={frame} positions={positions} />
  </g>;
}
function Tower({ frame }: { readonly frame: WorkFrame }) {
  const floors = [{ role: "referee", y: 115, label: "04  REVIEW ROOM" }, { role: "coach", y: 218, label: "03  COACH STUDIO" }, { role: "subject", y: 321, label: "02  INTERVIEW" }, { role: "evidence", y: 424, label: "01  RECORDS ARCHIVE" }] as const;
  const positions: Record<WorkRole, Point> = { referee: { x: 466, y: 144 }, coach: { x: 466, y: 247 }, subject: { x: 466, y: 350 }, evidence: { x: 466, y: 453 } };
  const latest = frame.transfers.at(-1);
  const liftY = latest === undefined ? 424 : between(positions[latest.from], positions[latest.to], latest.progress).y - 29;
  return <g data-scene="tower"><rect width="960" height="540" fill="#e9eeed" /><circle cx="821" cy="91" r="38" fill="#fff4d5" />
    {[82, 139, 188, 766, 822, 875].map((x, i) => <rect key={x} x={x} y={296 - i % 3 * 52} width="51" height={211 + i % 3 * 52} fill={i % 2 ? "#cbd7d5" : "#d8e1df"} />)}
    <text x="49" y="49" className="awm-scene-title">THE AGENT TOWER</text><text x="49" y="73" className="awm-svg-note">A cutaway of the session at work</text>
    <rect x="232" y="92" width="494" height="413" fill="#4d605c" /><path d="m219 92 38-35h446l37 35Z" fill="#324f46" /><rect x="274" y="65" width="338" height="19" fill="#d7c291" /><text x="443" y="79" textAnchor="middle" fontSize="11" fill="#233e35" letterSpacing="2">PUBLIC SESSION WORK</text>
    <rect x="642" y="104" width="65" height="391" fill="#a7b9b3" /><path d="M659 109v381M689 109v381" stroke="#d4ddd6" strokeWidth="2" />
    {floors.map((floor) => {
      const agent = frame.agents.find((item) => item.id === floor.role);
      return <g key={floor.role}><rect x="248" y={floor.y - 7} width="389" height="82" fill={agent?.status === "working" ? "#fbf0d6" : "#e7e9df"} /><path d={`M249 ${String(floor.y + 75)}h389`} stroke="#4a5a52" strokeWidth="9" /><rect x="258" y={floor.y + 1} width="111" height="57" fill="#d0ddd9" stroke="#90a69c" /><path d={`M294 ${String(floor.y + 1)}v57m36-57v57`} stroke="#90a69c" /><text x="379" y={floor.y + 7} className="awm-svg-note">{floor.label}</text>{agent === undefined ? null : <Person x={466} y={floor.y + 72} scale={.58} agent={agent} phase={frame.phase} />}<rect x="474" y={floor.y + 50} width="101" height="8" fill="#b99f78" /><path d={`M483 ${String(floor.y + 58)}v16m83-16v16`} stroke="#7b6e58" strokeWidth="4" /><rect x="505" y={floor.y + 25} width="32" height="22" rx="2" fill={agent?.status === "working" ? "#325e51" : "#465955"} /><path d={`M510 ${String(floor.y + 32)}h21m-21 6h14`} stroke="#a8d2b3" strokeWidth="2" /><text x="588" y={floor.y + 67} textAnchor="end" className="awm-svg-note">{agent === undefined ? "" : STATUS[agent.status]}</text></g>;
    })}
    <g className="awm-lift" transform={`translate(650 ${String(liftY - 1)})`}><rect width="49" height="65" rx="2" fill="#d6bd82" stroke="#7f6b41" strokeWidth="2" /><rect x="6" y="8" width="37" height="49" fill="#edf0e3" stroke="#948260" /><path d="M24.5 8v49" stroke="#948260" />{latest === undefined ? null : <rect x="14" y="28" width="21" height="15" fill="#fffdf6" stroke="#587c6b" />}</g>
    <rect x="220" y="505" width="520" height="10" fill="#697f74" /><rect x="35" y="515" width="890" height="4" fill="#b3c0ba" />
    <text x="76" y="462" className="awm-svg-note">ARCHIVE</text><text x="76" y="486" className="awm-scene-title">{frame.documents.length} RECORDS</text>
    <text x="770" y="421" className="awm-svg-note">FILED WORK</text><text x="770" y="447" className="awm-svg-label">{frame.cards} cards</text><text x="770" y="472" className="awm-svg-label">{frame.updates} updates</text><text x="770" y="497" className="awm-svg-label">{frame.flags.length} cited flags</text>
  </g>;
}

/** Self-contained presentation CSS also travels with the local SVG image used by Three.js. */
export const AGENT_WORK_SVG_CSS = `
.awm-scene-title { font-family: Georgia, serif; font-size: 21px; fill: #2f4438; letter-spacing: .7px; }
.awm-svg-label { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px; fill: #233d35; font-weight: 700; }
.awm-svg-note { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; fill: #445648; }
.awm-paper { fill: #fffdf6; stroke: #b6aa93; stroke-width: 1; }
.awm-paper-rule { stroke: #9aab9d; stroke-width: 2; }
.awm-scene[data-reduced-motion="true"] .awm-gesture { transform: none !important; }
.awm-scene[data-reduced-motion="true"] .awm-moving { display: none; }
`;

/** Reused verbatim by expanded DOM and physical screens. All text is React-escaped, with no external resources. */
export function AgentWorkSvg({ frame, style, id }: { readonly frame: WorkFrame; readonly style: WorkStyle; readonly id: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" className="awm-scene" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby={`${id}-title ${id}-description`} data-paused={frame.paused} data-reduced-motion={frame.reducedMotion}>
    <title id={`${id}-title`}>{STYLE_NAMES[style]}</title>
    <desc id={`${id}-description`}>{frame.caption} {frame.cards} coaching cards, {frame.updates} deep updates, {frame.documents.length} released records, {frame.flags.length} citation-checked flags. Activity is illustrative and does not indicate truth or deception.</desc>
    <style>{AGENT_WORK_SVG_CSS}</style>
    {style === "office" ? <Office frame={frame} /> : style === "case-board" ? <CaseBoard frame={frame} id={id} /> : style === "playhouse" ? <Playhouse frame={frame} /> : <Tower frame={frame} />}
  </svg>;
}

export function AgentWorkMonitor({ frame, style, size = "full", onExpand, onStyleChange, onInspect }: AgentWorkMonitorProps) {
  const id = useId();
  const title = STYLE_NAMES[style];
  const thumbnail = size === "thumbnail";
  return <figure className={`awm awm--${style} awm--${size}`} data-paused={frame.paused} data-reduced-motion={frame.reducedMotion}>
    <header className="awm-header"><div><span className="awm-eyebrow">AGENT ACTIVITY · {frame.available ? frame.assessment ? "ASSESSMENT" : "PRACTICE" : "NO SESSION"}</span><h3 id={`${id}-heading`}>{title}</h3></div><span className="awm-clock-label">{frame.paused ? "Paused" : "Session clock"}</span>{onExpand === undefined ? null : <button type="button" className="awm-expand" onClick={onExpand} aria-label={`Expand ${title}`}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M5 19 19 5M7 5h12v12" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg><span className="awm-sr-only"> Expand</span></button>}</header>
    {!thumbnail && onStyleChange !== undefined ? <div className="awm-style-picker" role="group" aria-label="Agent work screen style">{WORK_STYLES.map((candidate) => <button key={candidate} type="button" aria-pressed={candidate === style} onClick={() => { onStyleChange(candidate); }}>{STYLE_NAMES[candidate]}</button>)}</div> : null}
    <AgentWorkSvg frame={frame} style={style} id={id} />
    <figcaption><p className="awm-caption">{frame.caption}</p><ul className="awm-agent-status" aria-label="Agent status">{frame.agents.map((agent) => <li key={agent.id} data-status={agent.status}><span className="awm-status-dot" /><span><strong>{agent.name}</strong><span>{agent.task}</span></span></li>)}</ul>
      {!thumbnail ? <><details className="awm-record"><summary>Recorded work <span>{frame.items.length} items</span></summary>{frame.items.length === 0 ? <p>No public work has been filed yet.</p> : <ol tabIndex={0} aria-label="Recorded work items">{frame.items.map((item) => <li key={item.id}><span className="awm-item-kind">{item.kind}</span>{onInspect === undefined ? <span>{item.label}</span> : <button type="button" onClick={() => { onInspect(item); }}>{item.label}</button>}<span>{item.atMs === null ? "Already filed" : `${(item.atMs / 1_000).toFixed(1)} s`}</span></li>)}</ol>}{frame.flags.length > 0 ? <div className="awm-flag-quotes"><h4>Cited coach observations</h4><p>These are coach flags, not findings.</p>{frame.flags.map((flag) => <p key={flag.id}><strong>Turn {flag.turn}: {flag.label}.</strong> “{flag.quote}”{flag.recordId === null ? "" : ` · ${flag.recordId}`}{flag.conflictTurn === null ? "" : ` · compared with turn ${String(flag.conflictTurn)}`}</p>)}</div> : null}</details><p className="awm-safety">Activity shows recorded work only. Nervousness, demeanor, accent and stress are never evidence. {EX4_TEXT}</p></> : <p className="awm-thumbnail-note">Activity only · no truth or deception signal</p>}
    </figcaption>
  </figure>;
}
