/** Serialize handset updates so an older HTTP request cannot overwrite a newer draft. */
export class EditorSync {
  private tail: Promise<void> = Promise.resolve();

  constructor(private send: (text: string) => Promise<void>) {}

  update(text: string): Promise<void> {
    const pending = this.tail.catch(() => undefined).then(() => this.send(text));
    this.tail = pending;
    return pending;
  }
}
