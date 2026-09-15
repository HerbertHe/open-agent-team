export type ComposerEnterState = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
  isComposing: boolean;
};

/** A second unmodified Enter at the end of a non-empty draft submits it. */
export function shouldSubmitOnDoubleNewline(
  value: string,
  selectionStart: number | null,
  selectionEnd: number | null,
  key: ComposerEnterState,
): boolean {
  return key.key === 'Enter'
    && !key.shiftKey
    && !key.ctrlKey
    && !key.altKey
    && !key.metaKey
    && !key.repeat
    && !key.isComposing
    && selectionStart === value.length
    && selectionEnd === value.length
    && value.endsWith('\n')
    && Boolean(value.trim());
}
