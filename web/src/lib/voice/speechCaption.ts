/** A read-aloud caption exists only between this exact queue item's start and end. */
export interface SpokenCaption {
  readonly identity: object;
  readonly role: "subject" | "investigator" | "coach";
  readonly speaker: string;
  readonly text: string;
}
