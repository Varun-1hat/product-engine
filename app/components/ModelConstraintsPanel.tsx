import { sortConstraints, type ConstraintSeverity, type ModelConstraints } from "@/src/skills/model-prompt/constraints";

/**
 * The selected models' limits, shown to the user.
 *
 * Renders the SAME `ModelConstraints` objects that are injected into the
 * orchestrator LLM's system prompt (src/skills/model-prompt/constraints.ts) —
 * not a hand-written description of them. That is the point: the bounds the
 * user reads while choosing a model are, by construction, the bounds the scene
 * script is written against, so the panel cannot fall out of date with the
 * pipeline's behaviour.
 *
 * Why it exists at all: most of these limits produce no error. A model that
 * renders 8 seconds when the script asked for 2 just returns a longer clip and
 * a bigger bill, and the user's next move is to go looking for a bug that isn't
 * there. Stating the bound up front is cheaper than explaining it afterwards.
 */
export interface ModelConstraintsPanelProps {
  sets: ModelConstraints[];
  /** Optional lead-in above the list — e.g. what the constraints are being applied to. */
  description?: string;
  /** Compact spacing for use inside an existing card. */
  dense?: boolean;
}

const SEVERITY_LABEL: Record<ConstraintSeverity, string> = {
  blocking: "rejected",
  forced: "overridden",
  quality: "quality",
};

/**
 * `blocking` is destructive-red (the call fails), `forced` is warning-amber
 * (it succeeds but not as asked), `quality` is muted. The middle one carries
 * the most weight here — silent overrides are the class of problem this whole
 * panel exists for.
 */
const SEVERITY_CLASS: Record<ConstraintSeverity, string> = {
  blocking: "border-destructive/40 bg-destructive/5 text-destructive",
  forced: "border-warning/40 bg-warning/10 text-warning",
  quality: "border-border bg-muted/40 text-muted-foreground",
};

export function ModelConstraintsPanel({ sets, description, dense }: ModelConstraintsPanelProps) {
  if (sets.length === 0) return null;

  return (
    <section className={`flex flex-col ${dense ? "gap-2" : "gap-3"}`}>
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">What the selected models can do</h3>
        <p className="text-xs text-muted-foreground">
          {description ??
            "These are limits of the generation models themselves. Most do not produce an error — the model quietly renders something different from what was asked for."}
        </p>
      </div>

      {sets.map((set) => (
        <div key={`${set.role}:${set.model}`} className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{set.role}</span>
            <span className="text-sm font-medium">{set.model}</span>
          </div>

          <ul className="flex flex-col gap-1">
            {sortConstraints(set.items).map((item) => (
              <li
                key={item.label}
                className={`flex flex-col gap-0.5 rounded-md border p-2 text-xs ${SEVERITY_CLASS[item.severity]}`}
              >
                <span className="font-medium">
                  {item.label}
                  <span className="ml-1.5 font-normal opacity-70">({SEVERITY_LABEL[item.severity]})</span>
                </span>
                <span className="opacity-90">{item.detail}</span>
              </li>
            ))}
          </ul>

          {/* Provenance, so a surprising line can be checked against the provider
              rather than argued with — and so a stale list is visible as stale. */}
          <p className="text-[11px] text-muted-foreground">
            Verified {set.verified_on} against{" "}
            {set.source.startsWith("http") ? (
              <a href={set.source} target="_blank" rel="noreferrer" className="underline">
                provider docs
              </a>
            ) : (
              set.source
            )}
            .
          </p>
        </div>
      ))}
    </section>
  );
}
