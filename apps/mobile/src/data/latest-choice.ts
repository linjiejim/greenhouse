/**
 * A value chosen from a menu and saved to the server one change at a time. React-free
 * (./latest-choice.test.ts). At most one save is in flight; choosing again while one is in flight
 * queues the new choice (replacing any queued before it), and it is sent once the current save
 * settles — so the server ends on the member's last choice, in order. Only the last choice gets an
 * outcome: saved (with the server's answer), or failed with the value to roll back to — the last
 * one the server confirmed, even if a superseded save confirmed it.
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
  ) {}

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
