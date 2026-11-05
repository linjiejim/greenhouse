import { useEmbed } from '../embed';
import { facetLabel, valueLabel } from '../state';
import type { Facet, FacetValues } from '../types';
import { Chip } from './ui';

/** One row of chips per facet; `suggested` values (from AI) show dashed until chosen. */
export function FacetPicker({
  facets,
  value,
  onChange,
  suggested,
  hideLabels,
}: {
  facets: Facet[];
  value: FacetValues;
  onChange: (next: FacetValues) => void;
  suggested?: FacetValues;
  /** Inside a labelled row (the detail drawer) the facet name is already shown. */
  hideLabels?: boolean;
}) {
  const locale = useEmbed((s) => s.locale);
  return (
    <div className="flex flex-col gap-3">
      {facets.map((facet) => {
        const chosen = value[facet.key] ?? [];
        const toggle = (v: string) => {
          const has = chosen.includes(v);
          const next = facet.multiple ? (has ? chosen.filter((x) => x !== v) : [...chosen, v]) : has ? [] : [v];
          onChange({ ...value, [facet.key]: next });
        };
        return (
          <div key={facet.key} role="group" aria-label={facetLabel(facet, locale)} className="flex flex-col gap-1.5">
            {hideLabels ? null : <span className="text-label font-medium text-foreground">{facetLabel(facet, locale)}</span>}
            <div className="flex flex-wrap gap-1.5">
              {facet.values.map((v) => (
                <Chip
                  key={v.value}
                  selected={chosen.includes(v.value)}
                  ai={suggested?.[facet.key]?.includes(v.value)}
                  onClick={() => toggle(v.value)}
                >
                  {valueLabel(facet, v.value, locale)}
                </Chip>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
