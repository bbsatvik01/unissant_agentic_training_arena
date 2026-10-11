// @vitest-environment jsdom
/**
 * The trust center (S6 4.11): methodology carries EX-4 and the EVL-12 statement (FE-TRUST-2), the capability
 * matrix renders every fixture row (FE-TRUST-3), a $0 ceiling reads "Budget plan not applied" and applied values
 * render unchanged (FE-TRUST-4), and the in-browser check says match and mismatch (FE-TRUST-1).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import csv from "../../../../supabase/tests/fixtures/capability_matrix.csv?raw";
import { EX4_TEXT } from "../../lib/copy/ex4";
import { METRICS } from "../../lib/copy/metrics";
import { parseCapabilities } from "../../lib/trust/capability";
import { commitmentOf, verifyCommitment } from "../../lib/trust/commitment";
import { NIST_STATEMENT, TrustPage, type TrustPageProps } from "./TrustPage";

afterEach(() => {
  cleanup();
});

const MATRIX = parseCapabilities(csv);
const base: TrustPageProps = {
  section: "methodology",
  matrix: MATRIX,
  isolation: { state: "missing" },
  commitments: { state: "missing" },
  fairness: { state: "missing" },
  budget: { state: "missing" },
  phoenix: null,
  verify: verifyCommitment,
};

describe("TrustPage", () => {
  it("methodology carries EX-4, the EVL-12 statement with the NIST link, and every metric (FE-TRUST-2)", () => {
    render(<TrustPage {...base} />);
    expect(screen.getByText(EX4_TEXT)).toBeTruthy();
    expect(document.body.textContent).toContain(NIST_STATEMENT);
    expect(screen.getByRole("link", { name: /NIST AI RMF Playbook/ }).getAttribute("href")).toBe("https://airc.nist.gov/airmf-resources/playbook/measure/");
    expect(document.querySelectorAll("table.metrics tbody tr")).toHaveLength(METRICS.length);
  });

  it("renders every capability matrix row (FE-TRUST-3) and says when gate runs are not published", () => {
    render(<TrustPage {...base} section="isolation" />);
    expect(document.querySelectorAll("table.capability tbody tr")).toHaveLength(MATRIX.length);
    expect(MATRIX.length).toBeGreaterThan(100);
    expect(screen.getByText("The server does not publish this yet.")).toBeTruthy();
  });

  it("reads a $0 ceiling as the plan not applied, and shows applied values unchanged (FE-TRUST-4)", () => {
    const { unmount } = render(<TrustPage {...base} section="budget" budget={{ state: "ready", value: { ceiling: "$0.00", spent: "$0.00", byPurpose: [], plannedCases: null, applied: false } }} />);
    expect(screen.getByText("Budget plan not applied: no model spend is possible.")).toBeTruthy();
    unmount();
    render(<TrustPage {...base} section="budget" budget={{ state: "ready", value: { ceiling: "$75.00", spent: "$3.25", byPurpose: [{ purpose: "coach", spent: "$1.50" }], plannedCases: 30, applied: true } }} />);
    expect(screen.getByText(/Applied ceiling \$75\.00; spent so far \$3\.25; planned cases 30/)).toBeTruthy();
    expect(screen.getByText("$1.50")).toBeTruthy();
  });

  it("checks a pasted commitment in the browser: match, then mismatch after one changed character (FE-TRUST-1)", async () => {
    const nonce = "ab".repeat(32);
    const payload = '{"label": "deceptive"}';
    const commitment = (await commitmentOf(nonce, payload)) ?? "";
    render(<TrustPage {...base} section="commitments" />);
    fireEvent.change(screen.getByLabelText("Nonce (64 hex characters)"), { target: { value: nonce } });
    fireEvent.change(screen.getByLabelText("Payload text"), { target: { value: payload } });
    fireEvent.change(screen.getByLabelText("Published commitment (sha256)"), { target: { value: commitment } });
    fireEvent.click(screen.getByRole("button", { name: "Verify in browser" }));
    expect((await screen.findByRole("status")).getAttribute("data-verdict")).toBe("match");
    fireEvent.change(screen.getByLabelText("Payload text"), { target: { value: payload.replace("deceptive", "truthful") } });
    fireEvent.click(screen.getByRole("button", { name: "Verify in browser" }));
    expect((await screen.findByRole("status")).getAttribute("data-verdict")).toBe("mismatch");
  });

  it("verifies a published row with its revealed nonce and payload", async () => {
    const nonce = "cd".repeat(32);
    const payload = "{}";
    const commitment = (await commitmentOf(nonce, payload)) ?? "";
    render(<TrustPage {...base} section="commitments" commitments={{ state: "ready", value: [{ trial: "#1", commitment, transcriptSha: null, evidenceSha: null, payloadText: payload, nonce }, { trial: "#2", commitment, transcriptSha: null, evidenceSha: null, payloadText: null, nonce: null }] }} />);
    expect(screen.getByText("after reveal")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Verify in browser" })[0] as HTMLElement);
    expect(await screen.findByText("match")).toBeTruthy();
  });
});
