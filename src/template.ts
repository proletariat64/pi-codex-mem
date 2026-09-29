// Substitute placeholders once: replacement strings must not interpret `$&`, `$$`,
// `$\`` or `$'`, and inserted evidence must never become another placeholder.
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{ ([a-z_]+) \}\}/g, (placeholder, name: string) =>
    Object.hasOwn(values, name) ? values[name] ?? placeholder : placeholder);
}
