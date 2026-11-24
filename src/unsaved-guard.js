// One confirmation before unsaved marks would be thrown away (opening another
// document, closing to the recent list). Pure flow; the dialog and the save
// are injected.
//
//   isDirty(): are there marks not yet written to a file?
//   ask():     resolves to "save" | "discard" | "cancel"
//   save():    resolves to { ok } (the "save as copy" flow)
//
// confirmLeave() resolves to true when the caller may go ahead. While a
// question is on screen, further calls share it instead of stacking dialogs.
export function createUnsavedGuard({ isDirty, ask, save }) {
  let pending = null;

  return function confirmLeave() {
    if (!isDirty()) return Promise.resolve(true);
    if (pending) return pending;
    pending = (async () => {
      const choice = await ask();
      if (choice === "discard") return true;
      if (choice === "save") {
        const result = await save();
        return Boolean(result?.ok);
      }
      return false;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
