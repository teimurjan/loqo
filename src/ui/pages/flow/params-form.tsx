import { Input, Label, Textarea } from '../../components/ui/input';
import { Switch } from '../../components/ui/switch';
import type { JsonSchema } from '../../lib/api';

type Params = Record<string, unknown>;

type Props = { schema: JsonSchema; value: Params; onChange: (next: Params) => void; disabled?: boolean };

const asList = (value: unknown): string => (Array.isArray(value) ? value.join(', ') : '');

const fieldId = (key: string) => `param-${key}`;

/** Renders the top level of a guard kind's JSON schema; anything exotic falls back to raw JSON. */
export const ParamsForm = ({ schema, value, onChange, disabled }: Props) => {
  const properties = Object.entries(schema.properties ?? {});
  const required = new Set(schema.required ?? []);
  if (properties.length === 0) return <p className="text-xs text-muted-foreground">This guard takes no parameters.</p>;
  const set = (key: string, next: unknown) => {
    const { [key]: _removed, ...rest } = value;
    onChange(next === undefined || next === '' ? rest : { ...rest, [key]: next });
  };
  return (
    <div className="grid gap-3">
      {properties.map(([key, property]) => {
        const label = (
          <Label htmlFor={fieldId(key)}>
            {key}
            {required.has(key) ? ' *' : ''}
          </Label>
        );
        const hint = property.description ? <p className="text-xs text-muted-foreground">{property.description}</p> : null;
        switch (property.type) {
          case 'number':
          case 'integer':
            return (
              <div key={key} className="grid gap-1.5">
                {label}
                <Input
                  id={fieldId(key)}
                  type="number"
                  step={property.type === 'integer' ? 1 : 'any'}
                  value={typeof value[key] === 'number' ? String(value[key]) : ''}
                  onChange={(e) => set(key, e.target.value === '' ? undefined : Number(e.target.value))}
                  required={required.has(key)}
                  disabled={disabled}
                />
                {hint}
              </div>
            );
          case 'boolean':
            return (
              <div key={key} className="flex items-center gap-2">
                <Switch id={fieldId(key)} checked={value[key] === true} onCheckedChange={(checked) => set(key, checked)} disabled={disabled} />
                {label}
                {hint}
              </div>
            );
          case 'array':
            return (
              <div key={key} className="grid gap-1.5">
                {label}
                <Input
                  id={fieldId(key)}
                  value={asList(value[key])}
                  placeholder="comma separated"
                  onChange={(e) =>
                    set(
                      key,
                      e.target.value
                        .split(',')
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                  required={required.has(key)}
                  disabled={disabled}
                />
                {hint}
              </div>
            );
          case 'string':
            return (
              <div key={key} className="grid gap-1.5">
                {label}
                <Input id={fieldId(key)} value={typeof value[key] === 'string' ? value[key] : ''} onChange={(e) => set(key, e.target.value)} required={required.has(key)} disabled={disabled} />
                {hint}
              </div>
            );
          default:
            return (
              <div key={key} className="grid gap-1.5">
                {label}
                <Textarea
                  id={fieldId(key)}
                  className="font-mono text-xs"
                  value={value[key] === undefined ? '' : JSON.stringify(value[key], null, 2)}
                  onChange={(e) => {
                    try {
                      set(key, e.target.value ? JSON.parse(e.target.value) : undefined);
                    } catch {
                      // keep typing; an unparsable draft is not a value yet
                    }
                  }}
                  disabled={disabled}
                />
                {hint}
              </div>
            );
        }
      })}
    </div>
  );
};
