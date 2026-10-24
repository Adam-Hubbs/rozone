import type { CoreHover, CoreSignatureHelp, OffsetRange } from "./types.ts";

export interface HoverModel {
  markdown: string;
  range: OffsetRange;
}

export interface SignatureModel {
  label: string;
  documentation: string;
  parameters: { label: [number, number]; documentation: string }[];
  activeParameter: number;
}

/** PLAN §4.4: while docs are injected into the R session, Ark already hovers call sites. */
export function shouldShowHover(hover: CoreHover, injectedTopics: ReadonlySet<string>): boolean {
  return !(hover.kind === "call" && injectedTopics.has(hover.name));
}

export function toHoverModel(hover: CoreHover): HoverModel {
  return { markdown: hover.markdown, range: hover.range };
}

function validLabel(label: [number, number], length: number): boolean {
  const [start, end] = label;
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length;
}

export function toSignatureModel(help: CoreSignatureHelp): SignatureModel {
  const parameters = help.parameters.map((parameter) => ({
    // A tuple outside the label would make VS Code throw while rendering, so fall back to an empty span.
    label: validLabel(parameter.label, help.label.length) ? parameter.label : ([0, 0] as [number, number]),
    documentation: parameter.documentation,
  }));
  const active = help.activeParameter;
  return {
    label: help.label,
    documentation: help.documentation,
    parameters,
    // An index past the end highlights nothing, which is what an unmatched argument should do.
    activeParameter: active !== null && active >= 0 && active < parameters.length ? active : parameters.length,
  };
}
