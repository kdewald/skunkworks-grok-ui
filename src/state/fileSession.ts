/**
 * Files editor session: generation guards so late open/save cannot clobber
 * a newer file selection.
 */

export type FileSessionState<TFile> = {
  /** Bumps on every open / path change. */
  generation: number;
  activePath: string | null;
  file: TFile | null;
  draft: string;
  dirty: boolean;
  loading: boolean;
  error: string | null;
};

export function initialFileSession<TFile>(): FileSessionState<TFile> {
  return {
    generation: 0,
    activePath: null,
    file: null,
    draft: "",
    dirty: false,
    loading: false,
    error: null,
  };
}

/** Begin opening `path`; returns the generation for this open. */
export function beginOpenFile<TFile>(
  prev: FileSessionState<TFile>,
  path: string,
): FileSessionState<TFile> {
  return {
    ...prev,
    generation: prev.generation + 1,
    activePath: path,
    loading: true,
    error: null,
    dirty: false,
    // Keep previous file visible until new content arrives (optional); clear for safety.
    file: null,
    draft: "",
  };
}

/** Apply a successful open only if `gen` still matches. */
export function completeOpenFile<TFile>(
  prev: FileSessionState<TFile>,
  gen: number,
  path: string,
  file: TFile,
  draft: string,
): FileSessionState<TFile> {
  if (prev.generation !== gen || prev.activePath !== path) return prev;
  return {
    ...prev,
    file,
    draft,
    dirty: false,
    loading: false,
    error: null,
  };
}

/** Apply open failure only if still the same generation. */
export function failOpenFile<TFile>(
  prev: FileSessionState<TFile>,
  gen: number,
  path: string,
  error: string,
): FileSessionState<TFile> {
  if (prev.generation !== gen || prev.activePath !== path) return prev;
  return {
    ...prev,
    file: null,
    draft: "",
    loading: false,
    error,
    dirty: false,
  };
}

/** Begin save; returns generation that must still match on complete. */
export function beginSaveFile<TFile>(
  prev: FileSessionState<TFile>,
): { next: FileSessionState<TFile>; gen: number; path: string } | null {
  if (!prev.activePath || !prev.file || prev.loading) return null;
  return {
    next: prev,
    gen: prev.generation,
    path: prev.activePath,
  };
}

export function isCurrentSession(
  prev: FileSessionState<unknown>,
  gen: number,
  path: string,
): boolean {
  return prev.generation === gen && prev.activePath === path;
}
