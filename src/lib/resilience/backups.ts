// A small office's backup setup, and three things that go wrong. Each kind of
// copy is described by the properties that decide whether it survives: is it on
// the same disk, can the thing that attacked the primary reach it, does it
// faithfully copy mistakes, and how far back does it go. One configured copy is
// quietly broken, and only a restore drill finds out.

export type Copy = 'same-disk' | 'usb' | 'sync' | 'cloud' | 'offline';
export type Media = 'disk' | 'usb' | 'cloud' | 'offline';
export type Event = 'disk' | 'ransomware' | 'late-delete';

export const COPIES: Record<Copy, { label: string; media: Media; offsite: boolean; reachable: boolean; mirrors: boolean; keepsDays: number }> = {
  // A nightly copy into another folder of the same disk.
  'same-disk': { label: 'Nightly copy to another folder on the same disk', media: 'disk', offsite: false, reachable: true, mirrors: true, keepsDays: 1 },
  'usb': { label: 'USB drive, always plugged in, nightly copy', media: 'usb', offsite: false, reachable: true, mirrors: true, keepsDays: 1 },
  // Sync is not backup: it copies deletions and encrypted files within seconds.
  'sync': { label: 'Cloud sync folder', media: 'cloud', offsite: true, reachable: true, mirrors: true, keepsDays: 0 },
  // Versioned, offsite - but the office admin login can delete it.
  'cloud': { label: 'Cloud backup service, 30 days of versions', media: 'cloud', offsite: true, reachable: true, mirrors: false, keepsDays: 30 },
  // Unplugged and taken home; swapped every Friday, so it holds last week's state only.
  'offline': { label: 'Offline drive, swapped weekly and taken offsite', media: 'offline', offsite: true, reachable: false, mirrors: false, keepsDays: 7 },
};

export const EVENTS: Record<Event, string> = {
  'disk': 'The office server\'s disk dies',
  'ransomware': 'Ransomware encrypts every file it can reach - and goes looking for backups',
  'late-delete': 'A folder deleted ten days ago turns out to matter',
};

// What a successful restore from each copy actually gets back. One shared
// "from last night" note told the drill the weekly offline drive was a day old,
// contradicting the week of loss hit() reports for the same drive.
export const DRILL_OK: Record<Copy, string> = {
  'same-disk': 'restored a file from last night\'s copy; it matches',
  'usb': 'restored a file from last night\'s copy; it matches',
  'sync': 'restored a file from the sync folder; it matches the file as it is right now - mistakes included',
  'cloud': 'restored a file from last night\'s version; it matches',
  'offline': 'restored a file from the drive swapped out last Friday; it matches that day\'s version, and nothing newer is on it',
};

export type Result = { event: Event; survived: boolean; from?: Copy; why: string };
export type DrillLine = { copy: Copy; ok: boolean; note: string };

export class Office {
  copies = new Set<Copy>();
  // The cloud backup's saved password changed in March; the job has failed
  // every night since, and nothing told anyone.
  cloudBroken = true;
  drilled = false;
  history: Result[] = [];
  drills: DrillLine[][] = [];

  toggle(c: Copy, on: boolean) { if (on) this.copies.add(c); else this.copies.delete(c); }

  /** 3-2-1 as written: 3 copies (1 primary + 2 backups), 2 media types, 1 offsite. */
  rule321() {
    const list = [...this.copies];
    const media = new Set<Media>(['disk', ...list.map((c) => COPIES[c].media)]);
    const offsite = list.some((c) => COPIES[c].offsite);
    return { copies: 1 + list.length, media: media.size, offsite, met: 1 + list.length >= 3 && media.size >= 2 && offsite };
  }

  private working(c: Copy) { return !(c === 'cloud' && this.cloudBroken); }

  private reason(c: Copy, e: Event): string | null {
    const k = COPIES[c];
    if (!this.working(c)) return 'its job has been failing since March, so it holds March\'s files';
    if (e === 'disk' && k.media === 'disk') return 'it was on the disk that died';
    if (e === 'ransomware' && k.reachable) return c === 'cloud' ? 'the attacker used the office admin login to delete the backups' : 'the ransomware could reach it, and encrypted it too';
    if (e === 'late-delete' && k.mirrors) return 'it copied the deletion the same night';
    if (e === 'late-delete' && k.keepsDays < 10) return `it only goes back ${k.keepsDays} days`;
    return null;
  }

  hit(e: Event): Result {
    const order: Copy[] = ['offline', 'cloud', 'usb', 'sync', 'same-disk'];
    const survivor = order.find((c) => this.copies.has(c) && this.reason(c, e) === null);
    const lost = [...this.copies].map((c) => `${COPIES[c].label}: ${this.reason(c, e)}`);
    const r: Result = survivor
      ? { event: e, survived: true, from: survivor, why: `Restored from: ${COPIES[survivor].label}.${survivor === 'offline' ? ' Up to a week of work since the last swap is gone - the price of a copy nothing can reach.' : ''}` }
      : { event: e, survived: false, why: this.copies.size ? `Nothing to restore from. ${lost.join('. ')}.` : 'There were no backups at all.' };
    this.history.push(r);
    return r;
  }

  /** Restore one file from every copy and compare it with the original. */
  drill(): DrillLine[] {
    this.drilled = true;
    const lines = [...this.copies].map((c): DrillLine => this.working(c)
      ? { copy: c, ok: true, note: DRILL_OK[c] }
      : { copy: c, ok: false, note: 'newest restorable file is from 14 March. The job has failed every night since the saved password changed - and no alert was set' });
    this.drills.push(lines);
    return lines;
  }

  canFix() { return this.drilled && this.cloudBroken && this.copies.has('cloud'); }
  /** Re-enter the credentials and alert on any failed run. */
  fix() { if (this.canFix()) this.cloudBroken = false; }
}
