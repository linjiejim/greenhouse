/**
 * A value chosen from a menu and saved to the server one change at a time. React-free
 * (./latest-choice.test.ts). At most one save is in flight; choosing again while one is in flight
 * queues the new choice (replacing any queued before it), and it is sent once the current save
 * settles — so the server ends on the member's last choice, in order. Only the last choice gets an
 * outcome: saved (with the server's answer), or failed with the value to roll back to — the last
 * one the server confirmed, even if a superseded save confirmed it. Every save checks that the
 * station and account that chose are still active; after a switch the queue is dropped.
 */

export type ChoiceOutcome<T, R> = { ok: true; value: T; data: R } | { ok: false; rollbackTo: T; message: string };

type Save<T, R> = (value: T) => Promise<{ ok: true; data: R } | { ok: false; message: string }>;

export class LatestChoice<T, R> {
  private queued: { value: T; resolve: (outcome: ChoiceOutcome<T, R> | null) => void } | null = null;
  private saving = false;

  constructor(
    /** What the server holds now. */
    private confirmed: T,
    private save: Save<T, R>,
    /** Whether the station and account that made the first choice are still the active ones. */
    private stillCurrent: () => boolean = () => true,
  ) {}

  /** Nothing in flight or queued. */
  get idle(): boolean {
    return !this.saving && !this.queued;
  }

  /**
   * The server's value as freshly read (the screen reloaded). Taken only while idle: a save in
   * flight or queued is about to make the server's value its own.
   */
  rebase(value: T): void {
    if (this.idle) this.confirmed = value;
  }

  /** Choose a value; answers its outcome, or null once a later choice superseded it. */
  choose(value: T): Promise<ChoiceOutcome<T, R> | null> {
    return new Promise((resolve) => {
      this.queued?.resolve(null);
      this.queued = { value, resolve };
      if (!this.saving) void this.drain();
    });
  }

  private async drain(): Promise<void> {
    this.saving = true;
    while (this.queued) {
      const job = this.queued;
      this.queued = null;
      // checked right before each save: after a station or account switch nothing more is written,
      // and the choice is dropped rather than sent to the station that became active
      if (!this.stillCurrent()) {
        job.resolve(null);
        continue;
      }
      const result = await this.save(job.value);
      if (result.ok) this.confirmed = job.value;
      if (this.queued) {
        job.resolve(null);
        continue;
      }
      job.resolve(
        result.ok
          ? { ok: true, value: job.value, data: result.data }
          : { ok: false, rollbackTo: this.confirmed, message: result.message },
      );
    }
    this.saving = false;
  }
}
