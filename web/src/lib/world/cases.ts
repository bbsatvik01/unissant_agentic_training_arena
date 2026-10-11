/**
 * The practice case files on the hub's board: the public case-card fields of dev families F01-F05, one variant
 * each, as `GET /api/cases` lists them (S6 4.2). No role, style or family id is carried (FE-LIB-1). Live mode
 * replaces this list with the API's after WP-13.
 */
import data from "../../fixtures/cases.json";

export interface CaseCard {
  readonly case_id: string;
  readonly title: string;
  readonly objective: string;
  readonly domain: string;
  readonly difficulty_level: number;
  readonly subject: { readonly display_name: string; readonly position: string };
  readonly facility: string;
  readonly initial_documents: number;
  readonly requestable_records: number;
}

export const CASES: readonly CaseCard[] = data.cases;

/** The case with a recorded run that plays with no backend (D-021). */
export const RECORDED_CASE_ID = "C-7Q2MXK4D";
