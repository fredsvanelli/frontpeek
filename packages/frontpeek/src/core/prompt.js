// Builds the structured prompts the Edit (CSS) and Prompt (AI) tools copy to
// the clipboard. Ported from the extension's prompt builders; the only change
// is that `loc` already carries a project-relative `file` (resolved in the
// browser by source.js) instead of a VS Code URI.

export function buildAiPrompt(text, loc, source, element, url) {
  const lines = [];
  lines.push(text);
  lines.push('');
  lines.push(
    '- Task: apply the change described above to the exact JSX element below (confirm the target via selector, classes and text; if the line shifted, find the equivalent JSX in the same file)'
  );
  appendTargetContext(lines, loc, source, element, url);
  return lines.join('\n');
}

export function buildCssPrompt(changes, loc, source, element, url) {
  const lines = [];
  lines.push('Apply the following CSS changes to the JSX element described below.');
  lines.push('');
  lines.push('CSS changes (current computed value -> desired value):');
  for (const c of changes) {
    if (!c || !c.prop) continue;
    lines.push(`- ${c.prop}: ${c.from || 'unset'} -> ${c.to}`);
  }
  lines.push('');
  lines.push(
    '- Task: implement the CSS changes above on the exact JSX element below (confirm the target via selector, classes and text; if the line shifted, find the equivalent JSX in the same file). Use the styling system the element already uses (Tailwind classes, CSS Modules, styled-components, plain CSS, …) and follow the file conventions — do not add inline styles unless the element already uses them. The desired values were previewed live in the browser, so treat them as the exact intended result (equivalent utility classes or design tokens are fine).'
  );
  appendTargetContext(lines, loc, source, element, url);
  return lines.join('\n');
}

// Shared tail: everything the AI needs to locate the exact element.
function appendTargetContext(lines, loc, source, element, url) {
  if (loc && loc.file) {
    lines.push(`- File path: ${loc.file}:${loc.line || 1}:${loc.column || 1}`);
  } else {
    lines.push('- File path: unresolved — locate via the selector, classes and text below');
  }
  if (source && source.componentName) {
    lines.push(`- Component: ${source.componentName}`);
  }

  try {
    const u = new URL(url);
    lines.push(`- Route: ${u.pathname}${u.search}`);
    lines.push(`- URL: ${url}`);
  } catch (_) {}

  if (element) {
    if (element.tag) lines.push(`- Element: <${element.tag}>`);
    if (element.selector) lines.push(`- CSS Selector: ${element.selector}`);
    if (element.classes) lines.push(`- Classes: ${element.classes}`);
    if (element.text) lines.push(`- Text: "${element.text}"`);
  }
}
